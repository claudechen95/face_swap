import { createClient } from '@supabase/supabase-js';
import { normalizePhone } from './phone.js';
import { captureReferralCode, getReferralCode } from './referral.js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabaseConfig.js';

captureReferralCode();

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const modal = document.getElementById('preview-modal');

if (modal) {
  const phoneForm = modal.querySelector<HTMLFormElement>('.modal-phone-form')!;
  const otpForm = modal.querySelector<HTMLFormElement>('.modal-otp-form')!;
  const phoneError = phoneForm.querySelector<HTMLElement>('.modal-error')!;
  const otpError = otpForm.querySelector<HTMLElement>('.modal-error')!;
  const otpPhoneEl = otpForm.querySelector<HTMLElement>('[data-otp-phone]')!;
  const otpBackBtn = otpForm.querySelector<HTMLButtonElement>('.modal-otp-back')!;
  const phoneSubmitBtn = phoneForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const otpSubmitBtn = otpForm.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const eyebrowEl = modal.querySelector<HTMLElement>('[data-modal-eyebrow]')!;
  const titleEl = modal.querySelector<HTMLElement>('#modal-title')!;
  const modalSubEl = modal.querySelector<HTMLElement>('[data-modal-sub]')!;
  const nameField = phoneForm.querySelector<HTMLElement>('[data-name-field]')!;
  const nameInput = nameField.querySelector<HTMLInputElement>('input')!;
  const emailField = phoneForm.querySelector<HTMLElement>('[data-email-field]')!;
  const emailInput = emailField.querySelector<HTMLInputElement>('input')!;
  const phoneInput = phoneForm.querySelector<HTMLInputElement>('input[name="phone"]')!;
  let lastFocused: HTMLElement | null = null;
  let hasTrackedOpen = false;
  let hasStartedTyping = false;
  let hasVerified = false;
  let currentMode: 'signup' | 'signin' = 'signup';
  let pendingName = '';
  let pendingEmail = '';
  let pendingPhone = '';

  const COPY = {
    signup: {
      eyebrow: 'Reserve your spot',
      title: 'Start your free preview',
      sub: 'Verify your phone number—we’ll take you straight to your private upload page.',
    },
    signin: {
      eyebrow: 'Welcome back',
      title: 'Sign in to your account',
      sub: 'Verify your phone number to pick up right where you left off.',
    },
  };

  const showStep = (step: 'phone' | 'otp') => {
    phoneForm.hidden = step !== 'phone';
    otpForm.hidden = step !== 'otp';
  };

  const openModal = (mode: string) => {
    currentMode = mode === 'signin' ? 'signin' : 'signup';
    const copy = COPY[currentMode];
    eyebrowEl.textContent = copy.eyebrow;
    titleEl.textContent = copy.title;
    modalSubEl.textContent = copy.sub;

    nameField.hidden = currentMode === 'signin';
    nameInput.required = currentMode !== 'signin';
    emailField.hidden = currentMode === 'signin';
    emailInput.required = currentMode !== 'signin';

    lastFocused = document.activeElement as HTMLElement | null;
    modal.hidden = false;
    showStep('phone');
    phoneError.hidden = true;
    otpError.hidden = true;
    phoneForm.reset();
    otpForm.reset();
    hasStartedTyping = false;
    hasVerified = false;
    (currentMode === 'signin' ? phoneInput : nameInput).focus();
    if (typeof posthog !== 'undefined') posthog.capture('modal_opened', { mode: currentMode });
    if (!hasTrackedOpen && typeof fbq === 'function') {
      fbq('trackCustom', 'SignupStarted');
      hasTrackedOpen = true;
    }
  };

  const closeModal = () => {
    modal.hidden = true;
    if (lastFocused) lastFocused.focus();
    if (typeof posthog !== 'undefined') {
      posthog.capture('modal_closed', { mode: currentMode, completed: hasVerified });
    }
  };

  document.querySelectorAll<HTMLElement>('[data-open-modal="preview-modal"]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(trigger.dataset.modalMode === 'signin' ? 'signin' : 'signup');
    });
  });

  modal.querySelector<HTMLButtonElement>('.modal-close')!.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  otpBackBtn.addEventListener('click', () => {
    showStep('phone');
    otpError.hidden = true;
  });

  phoneForm.addEventListener('focusin', () => {
    if (hasStartedTyping) return;
    hasStartedTyping = true;
    if (typeof posthog !== 'undefined') posthog.capture('form_started', { mode: currentMode });
  });

  phoneForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    phoneError.hidden = true;

    const data = Object.fromEntries(new FormData(phoneForm).entries()) as Record<string, string>;
    const name = (data.name || '').trim();
    const email = (data.email || '').trim();
    const rawPhone = (data.phone || '').trim();

    if (currentMode === 'signup' && !name) {
      phoneError.textContent = 'Enter your full name.';
      phoneError.hidden = false;
      return;
    }
    if (currentMode === 'signup' && !email) {
      phoneError.textContent = 'Enter your email address.';
      phoneError.hidden = false;
      return;
    }
    if (!rawPhone) {
      phoneError.textContent = 'Enter your phone number.';
      phoneError.hidden = false;
      return;
    }

    const phone = normalizePhone(rawPhone);

    phoneSubmitBtn.disabled = true;
    phoneSubmitBtn.textContent = 'Sending…';
    if (typeof posthog !== 'undefined') posthog.capture('otp_requested', { mode: currentMode });

    const { error } = await supabase.auth.signInWithOtp({
      phone,
      options: { shouldCreateUser: currentMode !== 'signin' },
    });

    phoneSubmitBtn.disabled = false;
    phoneSubmitBtn.innerHTML = 'Send code <span>→</span>';

    if (error) {
      if (currentMode === 'signin') {
        // No account for this number — let them sign up instead of dead-ending.
        currentMode = 'signup';
        const copy = COPY.signup;
        eyebrowEl.textContent = copy.eyebrow;
        titleEl.textContent = copy.title;
        modalSubEl.textContent = copy.sub;
        nameField.hidden = false;
        nameInput.required = true;
        emailField.hidden = false;
        emailInput.required = true;
        phoneError.textContent = "We couldn't find an account for that number — enter your name to create one.";
        phoneError.hidden = false;
        nameInput.focus();
        if (typeof posthog !== 'undefined') posthog.capture('signin_fallback_to_signup');
        return;
      }
      phoneError.textContent = error.message || 'Could not send a code. Check the number and try again.';
      phoneError.hidden = false;
      if (typeof posthog !== 'undefined') posthog.capture('otp_request_failed', { reason: error.message });
      return;
    }

    pendingName = name;
    pendingEmail = email;
    pendingPhone = phone;

    if (currentMode === 'signup') {
      try {
        await fetch('/api/notify-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, phone }),
        });
      } catch (err) {
        console.error('signup notify failed', err);
      }
    }

    otpPhoneEl.textContent = phone;
    showStep('otp');
    otpForm.querySelector<HTMLInputElement>('input[name="code"]')!.focus();
  });

  otpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    otpError.hidden = true;

    const data = Object.fromEntries(new FormData(otpForm).entries()) as Record<string, string>;
    const code = (data.code || '').trim();
    if (!code) {
      otpError.textContent = 'Enter the code we sent you.';
      otpError.hidden = false;
      return;
    }

    otpSubmitBtn.disabled = true;
    otpSubmitBtn.textContent = 'Verifying…';
    if (typeof posthog !== 'undefined') posthog.capture('otp_verify_attempted');

    const {
      data: { session, user },
      error,
    } = await supabase.auth.verifyOtp({ phone: pendingPhone, token: code, type: 'sms' });

    if (error || !session || !user) {
      otpSubmitBtn.disabled = false;
      otpSubmitBtn.innerHTML = 'Verify <span>→</span>';
      otpError.textContent = error ? error.message : 'That code didn’t work. Try again.';
      otpError.hidden = false;
      if (typeof posthog !== 'undefined') posthog.capture('otp_verify_failed', { reason: error && error.message });
      return;
    }

    if (currentMode === 'signup') {
      // If this phone already has an account, they used the signup form to sign
      // in by mistake — treat it as a sign-in instead of overwriting their name.
      const { data: existingProfile } = await supabase.from('profiles').select('id').eq('id', user.id).maybeSingle();

      if (!existingProfile) {
        const profilePayload = { id: user.id, name: pendingName, email: pendingEmail, phone: pendingPhone, referred_by_code: getReferralCode() };
        let profileError: unknown = null;
        // Retry once -- a transient network blip here would otherwise silently
        // leave the signed-in user with no profile row, so every later lookup
        // (the upload page's own init call included) 500s and strands them.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            ({ error: profileError } = await supabase.from('profiles').insert(profilePayload));
          } catch (err) {
            profileError = err;
          }
          if (!profileError) break;
        }
        if (profileError) {
          console.error('profile insert failed', profileError);
          otpSubmitBtn.disabled = false;
          otpSubmitBtn.innerHTML = 'Verify <span>→</span>';
          otpError.textContent = "Your code was correct, but we couldn't finish setting up your account — please try again.";
          otpError.hidden = false;
          return;
        }

        if (typeof fbq === 'function') fbq('track', 'Lead');
      }
    }

    hasVerified = true;
    // Never let a PostHog hiccup (e.g. bot-detection dropping the event) block
    // the redirect -- signing in must not depend on analytics succeeding.
    try {
      if (typeof posthog !== 'undefined') {
        posthog.identify(user.id, { phone: pendingPhone, ...(pendingName ? { name: pendingName } : {}), ...(pendingEmail ? { email: pendingEmail } : {}) });
        posthog.capture('otp_verify_succeeded', { mode: currentMode });
      }
    } catch (err) {
      console.error('posthog capture failed', err);
    }

    location.href = '/upload';
  });
}
