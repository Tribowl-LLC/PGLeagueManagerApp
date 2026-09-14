import { type RefObject } from "react";
import { Loader2 } from "lucide-react";

// The admin record-payment dialog and the bowler setup card input render the
// same wallet buttons with slightly different sizing. Capture only those
// presentational deltas here so the markup, mount-node behavior, keyboard
// handlers, and the "processing wallet payment" affordance live in one place.
interface WalletVariantConfig {
  /** className applied to the always-mounted Apple Pay div when available. */
  applePayContainerClassName: string;
  /** Height class of the tokenize-only fallback Apple Pay <button>. */
  applePayButtonClassName: string;
  applePaySvgWidth: number;
  applePaySvgHeight: number;
  applePayLabelClassName: string;
  /** className applied to the always-mounted Google Pay div when available. */
  googlePayContainerClassName: string;
}

const VARIANTS: Record<"admin" | "bowler", WalletVariantConfig> = {
  admin: {
    applePayContainerClassName: "min-h-10",
    applePayButtonClassName: "h-11",
    applePaySvgWidth: 17,
    applePaySvgHeight: 21,
    applePayLabelClassName: "wallet-label-admin",
    googlePayContainerClassName: "w-full h-11",
  },
  bowler: {
    applePayContainerClassName: "min-h-12 cursor-pointer",
    applePayButtonClassName: "h-12",
    applePaySvgWidth: 19,
    applePaySvgHeight: 24,
    applePayLabelClassName: "wallet-label-bowler",
    googlePayContainerClassName: "min-h-12 cursor-pointer",
  },
};

export interface WalletPaymentButtonsProps {
  /** Sizing preset: `admin` = record-payment dialog, `bowler` = setup input. */
  variant: "admin" | "bowler";
  applePayAvailable: boolean;
  googlePayAvailable: boolean;
  applePayRef: RefObject<HTMLDivElement | null>;
  googlePayRef: RefObject<HTMLDivElement | null>;
  onApplePayClick: () => void;
  onGooglePayClick: () => void;
  isWalletProcessing: boolean;
  applePayTokenizeOnly: boolean;
  googlePayTokenizeOnly: boolean;
}

/**
 * Always-mounted Apple Pay / Google Pay wallet buttons.
 *
 * Square's `applePay.attach()` / `googlePay.attach()` run against the same
 * DOM node both before and after the `*Available` flag flips, so the rendered
 * wallet button isn't unmounted out from under us. (The previous pattern split
 * the ref across a hidden placeholder div and a separate visible div — when the
 * visible one took over, Square's attached button was destroyed and users saw
 * an empty clickable area.) On wallets that expose `tokenize()` without
 * `attach()` (tokenize-only), we render our own branded button instead.
 */
export function WalletPaymentButtons({
  variant,
  applePayAvailable,
  googlePayAvailable,
  applePayRef,
  googlePayRef,
  onApplePayClick,
  onGooglePayClick,
  isWalletProcessing,
  applePayTokenizeOnly,
  googlePayTokenizeOnly,
}: WalletPaymentButtonsProps) {
  const cfg = VARIANTS[variant];

  return (
    <>
      {!applePayTokenizeOnly && (
        <div
          ref={applePayRef}
          // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- Square's applePay.attach() injects its own button/iframe into this exact node; a semantic <button> can't legally contain that interactive content, so this mount node must stay a div with role="button".
          role="button"
          tabIndex={0}
          aria-label="Pay with Apple Pay"
          data-testid="wallet-apple-pay"
          className={applePayAvailable ? cfg.applePayContainerClassName : "hidden"}
          onClick={applePayAvailable ? onApplePayClick : undefined}
          onKeyDown={
            applePayAvailable
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onApplePayClick();
                  }
                }
              : undefined
          }
        />
      )}
      {applePayAvailable && applePayTokenizeOnly && (
        <button
          type="button"
          data-testid="wallet-apple-pay-tokenize"
          onClick={onApplePayClick}
          disabled={isWalletProcessing}
          className={`wallet-button gap-0.5 disabled:opacity-50 ${cfg.applePayButtonClassName}`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={cfg.applePaySvgWidth}
            height={cfg.applePaySvgHeight}
            viewBox="0 0 17 20"
            fill="currentColor"
            className="relative -top-px text-white"
          >
            <path d="M13.55 10.63a4.27 4.27 0 0 1 2.04-3.59 4.4 4.4 0 0 0-3.46-1.87c-1.46-.15-2.88.87-3.63.87s-1.91-.85-3.15-.83a4.65 4.65 0 0 0-3.91 2.38c-1.68 2.91-.43 7.2 1.19 9.56.8 1.15 1.74 2.44 2.98 2.4 1.2-.05 1.65-.77 3.1-.77s1.86.77 3.12.74c1.29-.02 2.1-1.16 2.88-2.32a10.4 10.4 0 0 0 1.31-2.69 4.13 4.13 0 0 1-2.47-3.88zM11.17 3.46A4.17 4.17 0 0 0 12.14 0a4.25 4.25 0 0 0-2.75 1.42 3.98 3.98 0 0 0-1 2.89 3.52 3.52 0 0 0 2.78-0.85z" />
          </svg>
          <span
            className={`wallet-label ${cfg.applePayLabelClassName}`}
          >
            Pay
          </span>
        </button>
      )}
      {!googlePayTokenizeOnly && (
        <div
          ref={googlePayRef}
          // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- Square's googlePay.attach() injects its own button/iframe into this exact node; a semantic <button> can't legally contain that interactive content, so this mount node must stay a div with role="button".
          role="button"
          tabIndex={0}
          aria-label="Pay with Google Pay"
          data-testid="wallet-google-pay"
          className={googlePayAvailable ? cfg.googlePayContainerClassName : "hidden"}
          onClick={googlePayAvailable ? onGooglePayClick : undefined}
          onKeyDown={
            googlePayAvailable
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onGooglePayClick();
                  }
                }
              : undefined
          }
        />
      )}
      {isWalletProcessing && (
        <div
          className="flex items-center justify-center gap-2 py-2"
          data-testid="wallet-processing"
        >
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            Processing wallet payment…
          </span>
        </div>
      )}
    </>
  );
}
