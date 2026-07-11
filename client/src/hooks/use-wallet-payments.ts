import { useState, useEffect, useRef, useCallback } from "react";
import { initializeSquare } from "@/lib/square";
import { logger } from "@/lib/logger";
import type { SquarePaymentRequest, SquareWalletPayment, TokenizeError } from "@/lib/square";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

function isCancelError(errors: TokenizeError[] | undefined): boolean {
  return !!errors?.some((e) =>
    e.message?.toLowerCase().includes('cancel') ||
    e.type?.toLowerCase().includes('cancel'),
  );
}

// task #670: Google Pay can never render in iOS Safari (no GPay
// support on iOS), but Square's `payments.googlePay()` still
// resolves and `attach()` still succeeds — leaving us with an
// empty black bar. Gate availability on the underlying browser
// support (PaymentRequest API present + not iOS Safari) so we
// skip the attach entirely when it can't possibly paint.
function isGooglePaySupportedInBrowser(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  if (typeof (window as { PaymentRequest?: unknown }).PaymentRequest !== 'function') {
    return false;
  }
  const ua = navigator.userAgent || '';
  const isIOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports MacIntel + touch — treat as iOS too.
  const isIPadOS =
    navigator.platform === 'MacIntel' &&
    typeof (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints === 'number' &&
    ((navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints || 0) > 1;
  if (isIOSDevice || isIPadOS) {
    return false;
  }
  return true;
}

// task #670: Defense-in-depth — confirm Square actually injected
// a visible button into our container after attach(). If the
// container is empty, treat the wallet as unavailable so we
// don't show an empty clickable bar even if a future SDK
// regression silently no-ops `attach()`.
function hasRenderedWalletContent(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.childElementCount === 0) return false;
  const html = el.innerHTML?.trim() ?? '';
  return html.length > 0;
}

interface UseWalletPaymentsOptions {
  locationId?: number | null;
  amountCents: number;
  enabled: boolean;
  onTokenReceived: (token: string, walletType: 'apple_pay' | 'google_pay') => Promise<void>;
  onError: (error: string) => void;
}

interface UseWalletPaymentsReturn {
  applePayAvailable: boolean;
  googlePayAvailable: boolean;
  applePayTokenizeOnly: boolean;
  googlePayTokenizeOnly: boolean;
  applePayRef: React.RefObject<HTMLDivElement | null>;
  googlePayRef: React.RefObject<HTMLDivElement | null>;
  handleApplePayClick: () => Promise<void>;
  handleGooglePayClick: () => Promise<void>;
  isProcessing: boolean;
  cleanup: () => void;
  debugStatus: string;
}

export function useWalletPayments({
  locationId,
  amountCents,
  enabled,
  onTokenReceived,
  onError,
}: UseWalletPaymentsOptions): UseWalletPaymentsReturn {
  const [applePayAvailable, setApplePayAvailable] = useState(false);
  const [googlePayAvailable, setGooglePayAvailable] = useState(false);
  const [applePayTokenizeOnly, setApplePayTokenizeOnly] = useState(false);
  const [googlePayTokenizeOnly, setGooglePayTokenizeOnly] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [debugStatus, setDebugStatus] = useState('waiting');

  const applePayRef = useRef<HTMLDivElement>(null!);
  const googlePayRef = useRef<HTMLDivElement>(null!);
  const paymentRequestRef = useRef<SquarePaymentRequest | null>(null);
  const applePayInstanceRef = useRef<SquareWalletPayment | null>(null);
  const googlePayInstanceRef = useRef<SquareWalletPayment | null>(null);
  const mountedRef = useRef(true);
  const initializedRef = useRef(false);
  const onTokenReceivedRef = useRef(onTokenReceived);
  const onErrorRef = useRef(onError);

  onTokenReceivedRef.current = onTokenReceived;
  onErrorRef.current = onError;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (paymentRequestRef.current && amountCents > 0) {
      try {
        paymentRequestRef.current.update({
          total: {
            amount: (amountCents / 100).toFixed(2),
            label: 'Total',
          },
        });
      } catch (err) {
        logger.error('WalletPayments', 'Error updating payment request', err);
      }
    }
  }, [amountCents]);

  const prevLocationIdRef = useRef<number | null | undefined>(undefined);

  const destroyInstances = useCallback(() => {
    try { applePayInstanceRef.current?.destroy(); } catch {}
    try { googlePayInstanceRef.current?.destroy(); } catch {}
    applePayInstanceRef.current = null;
    googlePayInstanceRef.current = null;
    paymentRequestRef.current = null;
    initializedRef.current = false;
    setApplePayAvailable(false);
    setGooglePayAvailable(false);
    setApplePayTokenizeOnly(false);
    setGooglePayTokenizeOnly(false);
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (initializedRef.current) {
        destroyInstances();
      }
      setDebugStatus('disabled');
      prevLocationIdRef.current = locationId;
      return;
    }

    if (!locationId) {
      setDebugStatus('no-locationId');
      prevLocationIdRef.current = locationId;
      return;
    }

    const locationChanged = prevLocationIdRef.current !== undefined && prevLocationIdRef.current !== locationId;
    if (locationChanged && initializedRef.current) {
      destroyInstances();
    }
    prevLocationIdRef.current = locationId;

    if (initializedRef.current) return;

    let cancelled = false;

    async function init() {
      try {
        setDebugStatus(`init:loc=${locationId}`);
        const payments = await initializeSquare(locationId);
        if (cancelled || !mountedRef.current) return;
        setDebugStatus(`square-ready`);

        const amount = amountCents > 0 ? (amountCents / 100).toFixed(2) : '1.00';
        const paymentRequest = payments.paymentRequest({
          countryCode: 'US',
          currencyCode: 'USD',
          total: { amount, label: 'Total' },
        });
        paymentRequestRef.current = paymentRequest;

        let appleResult = 'skip';
        let appleAttached = false;
        try {
          setDebugStatus('trying-apple');
          const applePay = await payments.applePay(paymentRequest);
          if (!applePay || (typeof applePay.attach !== 'function' && typeof applePay.tokenize !== 'function')) {
            appleResult = `not-available`;
          } else if (cancelled || !mountedRef.current) {
            appleResult = `cancelled`;
          } else if (typeof applePay.attach === 'function') {
            if (!applePayRef.current) {
              appleResult = 'ref-not-ready';
            } else {
              await applePay.attach(applePayRef.current);
              applePayInstanceRef.current = applePay;
              setApplePayAvailable(true);
              appleAttached = true;
              appleResult = 'attached';
            }
          } else {
            applePayInstanceRef.current = applePay;
            setApplePayAvailable(true);
            setApplePayTokenizeOnly(true);
            appleResult = 'tokenize-only';
          }
        } catch (appleErr: unknown) {
          appleResult = `ERR:${errorMessage(appleErr)}`;
        }

        let googleResult = 'skip';
        let googleAttached = false;
        try {
          setDebugStatus('trying-google');
          // task #670: Skip Google Pay entirely when the browser
          // can't render it (e.g. iOS Safari). Square's
          // `googlePay.attach()` succeeds there but paints
          // nothing, leaving an empty black bar.
          if (!isGooglePaySupportedInBrowser()) {
            googleResult = 'unsupported-browser';
          } else {
            const googlePay = await payments.googlePay(paymentRequest);
            if (!googlePay || (typeof googlePay.attach !== 'function' && typeof googlePay.tokenize !== 'function')) {
              googleResult = `not-available`;
            } else if (cancelled || !mountedRef.current) {
              googleResult = `cancelled`;
            } else if (typeof googlePay.attach === 'function') {
              if (!googlePayRef.current) {
                googleResult = 'ref-not-ready';
              } else {
                await googlePay.attach(googlePayRef.current, {
                  buttonColor: 'black',
                  buttonType: 'long',
                  buttonSizeMode: 'fill',
                });
                // task #670: Defense-in-depth — verify Square
                // actually painted a button. If the container is
                // empty, treat as unavailable and clean up.
                if (!hasRenderedWalletContent(googlePayRef.current)) {
                  try { googlePay.destroy(); } catch {}
                  googleResult = 'attached-but-empty';
                } else {
                  googlePayInstanceRef.current = googlePay;
                  setGooglePayAvailable(true);
                  googleAttached = true;
                  googleResult = 'attached';
                }
              }
            } else {
              googlePayInstanceRef.current = googlePay;
              setGooglePayAvailable(true);
              setGooglePayTokenizeOnly(true);
              googleResult = 'tokenize-only';
            }
          }
        } catch (googleErr: unknown) {
          googleResult = `ERR:${errorMessage(googleErr)}`;
        }

        if (!cancelled) {
          const anyRefMissing = appleResult === 'ref-not-ready' || googleResult === 'ref-not-ready';
          if (!anyRefMissing) {
            initializedRef.current = true;
          }
        }
        setDebugStatus(`done|apple:${appleResult}|google:${googleResult}`);
      } catch (err: unknown) {
        setDebugStatus(`FAIL:${errorMessage(err)}`);
      }
    }

    const timer = setTimeout(init, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [enabled, locationId, destroyInstances]);

  const handleApplePayClick = useCallback(async () => {
    if (!applePayInstanceRef.current || isProcessing) return;
    if (amountCents <= 0) {
      onErrorRef.current('Please enter a valid payment amount');
      return;
    }
    setIsProcessing(true);
    try {
      const result = await applePayInstanceRef.current.tokenize();
      if (result.status === 'OK' && result.token) {
        await onTokenReceivedRef.current(result.token, 'apple_pay');
      } else if (result.status === 'CANCEL' || result.status === 'Cancel') {
      } else {
        if (!isCancelError(result.errors)) {
          const errorMsg = result.errors?.map((e) => e.message).join(', ') || 'Apple Pay payment was not completed';
          onErrorRef.current(errorMsg);
        }
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('abort')) {
        onErrorRef.current(msg || 'Apple Pay failed');
      }
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  }, [isProcessing, amountCents]);

  const handleGooglePayClick = useCallback(async () => {
    if (!googlePayInstanceRef.current || isProcessing) return;
    if (amountCents <= 0) {
      onErrorRef.current('Please enter a valid payment amount');
      return;
    }
    setIsProcessing(true);
    try {
      const result = await googlePayInstanceRef.current.tokenize();
      if (result.status === 'OK' && result.token) {
        await onTokenReceivedRef.current(result.token, 'google_pay');
      } else if (result.status === 'CANCEL' || result.status === 'Cancel') {
      } else {
        if (!isCancelError(result.errors)) {
          const errorMsg = result.errors?.map((e) => e.message).join(', ') || 'Google Pay payment was not completed';
          onErrorRef.current(errorMsg);
        }
      }
    } catch (err: unknown) {
      const msg = errorMessage(err);
      if (!msg.toLowerCase().includes('cancel') && !msg.toLowerCase().includes('abort')) {
        onErrorRef.current(msg || 'Google Pay failed');
      }
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  }, [isProcessing, amountCents]);

  const cleanup = destroyInstances;

  return {
    applePayAvailable,
    googlePayAvailable,
    applePayTokenizeOnly,
    googlePayTokenizeOnly,
    applePayRef,
    googlePayRef,
    handleApplePayClick,
    handleGooglePayClick,
    isProcessing,
    cleanup,
    debugStatus,
  };
}
