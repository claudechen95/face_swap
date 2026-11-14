// PostHog and the Facebook pixel are loaded via inline <script> tags in
// index.html/upload.html, not imported -- these ambient declarations just
// satisfy the compiler for the existing `typeof posthog !== 'undefined'`
// guard pattern (a legitimate no-throw check for a possibly-absent global).
declare const posthog:
  | {
      capture: (...args: unknown[]) => void;
      identify: (...args: unknown[]) => void;
    }
  | undefined;
declare const fbq: ((...args: unknown[]) => void) | undefined;
