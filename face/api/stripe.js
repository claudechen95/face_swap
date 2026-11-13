const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { resolveIdentity } = require('./_lib/identity');

const PRICE_CENTS = 5000; // $50 -- unlocks downloads + raises the target-photo cap
const REFERRAL_COUPON_ID = 'referral-15off'; // $15 off, auto-applied when checking out with a referred_by_code

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Stripe's webhook needs the exact raw bytes it sent (for signature
// verification), so body parsing is disabled for this whole file --
// handleCreateCheckout parses the JSON body itself from the same buffer.
async function handleWebhook(req, res, rawBody) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error('Missing SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, or STRIPE_WEBHOOK_SECRET env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { ownerColumn, ownerId } = session.metadata || {};

    if ((ownerColumn === 'user_id' || ownerColumn === 'submission_id') && ownerId) {
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
      if (!error && table === 'profiles' && updated && updated.referred_by_code) {
        const { data: referrer, error: referrerLookupError } = await supabase
          .from('profiles')
          .select('id')
          .eq('referral_code', updated.referred_by_code)
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

async function handleCreateCheckout(req, res) {
  // Admin "view as" is allowed to create a real, live checkout session so admins
  // can see exactly what a customer sees -- the frontend shows a loud warning
  // banner in the modal in this case, since this is a genuine live charge that
  // marks the impersonated customer's account as paid if actually completed.
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !STRIPE_SECRET_KEY || !STRIPE_PUBLISHABLE_KEY) {
    console.error('Missing SUPABASE_URL, SUPABASE_SECRET_KEY, STRIPE_SECRET_KEY, or STRIPE_PUBLISHABLE_KEY env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const identity = await resolveIdentity(req, supabase);
  if (!identity) {
    return res.status(404).json({ error: 'This upload link is invalid' });
  }

  const table = identity.column === 'user_id' ? 'profiles' : 'submissions';
  const ownerSelect = table === 'profiles' ? 'name, email, paid_at, referred_by_code' : 'name, email, paid_at';
  const { data: owner, error: ownerError } = await supabase
    .from(table)
    .select(ownerSelect)
    .eq('id', identity.id)
    .maybeSingle();

  if (ownerError || !owner) {
    console.error('Owner lookup failed', ownerError);
    return res.status(500).json({ error: 'Could not verify link' });
  }
  if (owner.paid_at) {
    return res.status(400).json({ error: 'Already paid' });
  }

  // A referral discount auto-applies (no code to type) whenever this account
  // was signed up via a friend's link -- takes priority over the general
  // allow_promotion_codes field since Stripe rejects sessions with both set.
  let hasReferralDiscount = false;
  if (table === 'profiles' && owner.referred_by_code) {
    const { data: referrer, error: referrerError } = await supabase
      .from('profiles')
      .select('id')
      .eq('referral_code', owner.referred_by_code)
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
      ui_mode: 'embedded_page',
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
      customer_email: owner.email || undefined,
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
    return res.status(502).json({ error: 'Could not start checkout' });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
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
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  return handleCreateCheckout(req, res);
};

module.exports.config = { api: { bodyParser: false } };
