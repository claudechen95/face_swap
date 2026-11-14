import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { resolveIdentity } from './_lib/identity.js';
import { getSupabaseClient } from './_lib/supabaseClient.js';
import { sendError } from './_lib/http.js';

const PRICE_CENTS = 5000; // $50 -- unlocks downloads + raises the target-photo cap
const REFERRAL_COUPON_ID = 'referral-15off'; // $15 off, auto-applied when checking out with a referred_by_code

async function buffer(readable: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Stripe's webhook needs the exact raw bytes it sent (for signature
// verification), so body parsing is disabled for this whole file --
// handleCreateCheckout parses the JSON body itself from the same buffer.
async function handleWebhook(req: VercelRequest, res: VercelResponse, rawBody: Buffer) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error('Missing SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, or STRIPE_WEBHOOK_SECRET env vars');
    return sendError(res, 500, 'Server misconfigured');
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'] as string, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed', (err as Error).message);
    return res.status(400).json({ error: `Webhook Error: ${(err as Error).message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { ownerColumn, ownerId } = session.metadata || {};

    if ((ownerColumn === 'user_id' || ownerColumn === 'submission_id') && ownerId) {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
      const table = ownerColumn === 'user_id' ? 'profiles' : 'submissions';
      // .is('paid_at', null) makes this idempotent against Stripe's at-least-once
      // webhook retries -- a duplicate delivery is a harmless no-op instead of
      // clobbering the original paid_at timestamp. select() only returns a row
      // when the update actually applied, which doubles as the "first time paid"
      // signal the referral-reward step below relies on.
      const selectCols = table === 'profiles' ? 'referred_by_code' : 'id';
      const { data: updated, error } = await supabase
        .from(table)
        .update({ paid_at: new Date().toISOString(), stripe_checkout_session_id: session.id })
        .eq('id', ownerId)
        .is('paid_at', null)
        .select(selectCols)
        .maybeSingle();

      if (error) console.error(`Failed to mark ${table} ${ownerId} as paid`, error);

      // Referrals only exist between signed-in accounts (submissions/legacy
      // leads have no referred_by_code column) -- comp the referrer's own
      // unlock for free, but only the first time and only if they haven't
      // already paid for real.
      if (!error && table === 'profiles' && updated && (updated as { referred_by_code?: string }).referred_by_code) {
        const { data: referrer, error: referrerLookupError } = await supabase
          .from('profiles')
          .select('id')
          .eq('referral_code', (updated as { referred_by_code: string }).referred_by_code)
          .neq('id', ownerId)
          .maybeSingle();

        if (referrerLookupError) {
          console.error('Referrer lookup failed', referrerLookupError);
        } else if (referrer) {
          const { error: rewardError } = await supabase
            .from('profiles')
            .update({ paid_at: new Date().toISOString(), referral_reward_granted_at: new Date().toISOString() })
            .eq('id', referrer.id)
            .is('paid_at', null);
          if (rewardError) console.error(`Failed to grant referral reward to ${referrer.id}`, rewardError);
        }
      }
    } else {
      console.error('checkout.session.completed missing/invalid metadata', session.metadata);
    }
  }

  return res.status(200).json({ received: true });
}

async function handleCreateCheckout(req: VercelRequest, res: VercelResponse) {
  // Admin "view as" is allowed to create a real, live checkout session so admins
  // can see exactly what a customer sees -- the frontend shows a loud warning
  // banner in the modal in this case, since this is a genuine live charge that
  // marks the impersonated customer's account as paid if actually completed.
  const { STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_PUBLISHABLE_KEY) {
    console.error('Missing STRIPE_SECRET_KEY or STRIPE_PUBLISHABLE_KEY env vars');
    return sendError(res, 500, 'Server misconfigured');
  }

  const supabase = getSupabaseClient(res);
  if (!supabase) return;
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return sendError(res, 404, 'This upload link is invalid');
  }

  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const ownerSelect = table === 'profiles' ? 'name, email, paid_at, referred_by_code' : 'name, email, paid_at';
  const { data: owner, error: ownerError } = await supabase.from(table).select(ownerSelect).eq('id', identity.id).maybeSingle();

  if (ownerError || !owner) {
    console.error('Owner lookup failed', ownerError);
    return sendError(res, 500, 'Could not verify link');
  }
  if ((owner as { paid_at?: string }).paid_at) {
    return sendError(res, 400, 'Already paid');
  }

  // A referral discount auto-applies (no code to type) whenever this account
  // was signed up via a friend's link -- takes priority over the general
  // allow_promotion_codes field since Stripe rejects sessions with both set.
  let hasReferralDiscount = false;
  const ownerWithReferral = owner as { referred_by_code?: string };
  if (table === 'profiles' && ownerWithReferral.referred_by_code) {
    const { data: referrer, error: referrerError } = await supabase
      .from('profiles')
      .select('id')
      .eq('referral_code', ownerWithReferral.referred_by_code)
      .neq('id', identity.id)
      .maybeSingle();
    if (referrerError) console.error('Referrer lookup failed', referrerError);
    hasReferralDiscount = Boolean(referrer);
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${host}`;
  const { token } = req.body || {};
  const returnParams = new URLSearchParams();
  if (typeof token === 'string' && token.trim()) returnParams.set('token', token.trim());
  returnParams.set('checkout', 'success');

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ui_mode: 'embedded_page' as Stripe.Checkout.SessionCreateParams.UiMode,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: PRICE_CENTS,
            product_data: {
              name: 'Better Hello Studio — Unlock downloads & more swaps',
              description: 'Unlocks downloading your face-swap results and raises your swap limit from 3 to 20.',
            },
          },
          quantity: 1,
        },
      ],
      customer_email: (owner as { email?: string }).email || undefined,
      client_reference_id: String(identity.id),
      metadata: { ownerColumn: identity.column, ownerId: String(identity.id) },
      ...(hasReferralDiscount ? { discounts: [{ coupon: REFERRAL_COUPON_ID }] } : { allow_promotion_codes: true }),
      // Embedded Checkout auto-navigates the page here once payment succeeds --
      // there's no separate cancel_url since the user just closes the modal instead.
      return_url: `${origin}/results?${returnParams.toString()}`,
    });

    return res.status(200).json({ clientSecret: session.client_secret, publishableKey: STRIPE_PUBLISHABLE_KEY });
  } catch (err) {
    console.error('Stripe checkout session creation failed', err);
    return sendError(res, 502, 'Could not start checkout');
  }
}

module.exports = async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendError(res, 405, 'Method not allowed');
  }

  const rawBody = await buffer(req);

  // Only Stripe's own webhook deliveries carry this header -- everything else
  // hitting this endpoint is the browser asking us to start a checkout.
  if (req.headers['stripe-signature']) {
    return handleWebhook(req, res, rawBody);
  }

  try {
    req.body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {};
  } catch (err) {
    return sendError(res, 400, 'Invalid JSON body');
  }

  return handleCreateCheckout(req, res);
};

module.exports.config = { api: { bodyParser: false } };
