import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { initializeSquare, resetSquarePayments, getPreWarmedCard, cardStyle } from "@/lib/square";
import { logger } from "@/lib/logger";
import { sanitizePaymentErrorMessage } from "@/lib/payment-user-error";

interface SquareCardTokenizeResult {
  status: string;
  token?: string;
  errors?: Array<{ message: string }>;
}

export interface SquareCard {
  tokenize(options?: Record<string, unknown>): Promise<SquareCardTokenizeResult>;
  destroy(): void;
  attach(container: HTMLElement): Promise<void>;
}

interface UseSquarePaymentOptions {
  onError?: (error: string) => void;
  locationId?: number | null;
}

interface UseSquarePaymentReturn {
  card: SquareCard | null;
  isInitialized: boolean;
  error: string | null;
  initializeCard: (container: HTMLDivElement) => Promise<void>;
  cleanupCard: () => void;
}

export function useSquarePayment({ onError, locationId }: UseSquarePaymentOptions = {}): UseSquarePaymentReturn {
  const [card, setCard] = useState<SquareCard | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const mountedRef = useRef(true);
  const cardRef = useRef<SquareCard | null>(null);
  const initializingRef = useRef(false);
  const initializationAttempts = useRef(0);
  const onErrorRef = useRef(onError);
  const locationIdRef = useRef(locationId);
  const maxAttempts = 3;

  onErrorRef.current = onError;
  locationIdRef.current = locationId;

  const cleanupCard = useCallback(() => {
    if (cardRef.current) {
      try {
        cardRef.current.destroy();
      } catch (e) {
        logger.error('useSquarePayment', 'Error during cleanup', e);
      }
      cardRef.current = null;
    }
    initializingRef.current = false;
    resetSquarePayments();
    setCard(null);
    setIsInitialized(false);
    setError(null);
  }, []);

  const initializeCard = useCallback(async (container: HTMLDivElement) => {
    if (!container || !container.isConnected || !mountedRef.current) {
      return;
    }

    if (cardRef.current || initializingRef.current) {
      return;
    }

    initializingRef.current = true;
    let initTimeout: ReturnType<typeof setTimeout> | undefined;
    let pendingCard: SquareCard | null = null;

    try {
      initTimeout = setTimeout(() => {
        if (!container.isConnected) {
          initializingRef.current = false;
          return;
        }
        if (mountedRef.current && !cardRef.current) {
          setError('Card initialization timed out');
          initializingRef.current = false;

          if (initializationAttempts.current < maxAttempts) {
            initializationAttempts.current++;
          } else {
            initializationAttempts.current = 0;
            if (onErrorRef.current) {
              onErrorRef.current('Credit card form initialization timed out');
            } else {
              toast({
                title: "Payment Form Notice",
                description: "Credit card payment form unavailable. Please try another payment method.",
                variant: "destructive",
              });
            }
          }
        }
      }, 8000);

      const payments = await initializeSquare(locationIdRef.current);

      if (!mountedRef.current || !container.isConnected) {
        clearTimeout(initTimeout);
        initializingRef.current = false;
        return;
      }

      pendingCard = getPreWarmedCard();
      if (!pendingCard) {
        pendingCard = await payments.card({ style: cardStyle });
      }

      if (!mountedRef.current || !container.isConnected) {
        clearTimeout(initTimeout);
        pendingCard.destroy();
        initializingRef.current = false;
        return;
      }

      await pendingCard.attach(container);
      clearTimeout(initTimeout);

      if (mountedRef.current && container.isConnected) {
        cardRef.current = pendingCard;
        setCard(pendingCard);
        setIsInitialized(true);
        setError(null);
        initializationAttempts.current = 0;
        initializingRef.current = false;
      } else {
        pendingCard.destroy();
        initializingRef.current = false;
      }
    } catch (err) {
      if (initTimeout) clearTimeout(initTimeout);
      if (pendingCard && cardRef.current !== pendingCard) {
        try { pendingCard.destroy(); } catch {}
      }
      initializingRef.current = false;
      // React may remove the editor while Square is resolving (for example,
      // when a saved-card query finishes). That is cancellation, not a
      // customer-facing provider failure, and retrying the detached node can
      // only reproduce Square's ElementNotFoundError.
      if (!container.isConnected || !mountedRef.current) return;
      logger.error('useSquarePayment', 'Card initialization error', err);
      // task #514: sanitize the SDK init error before surfacing it,
      // so a stack-trace fragment or JSON-shaped string from the
      // Square SDK can't leak into the user-visible toast.
      const errorMessage = sanitizePaymentErrorMessage(
        err,
        'Failed to initialize payment form',
      );

      if (mountedRef.current) {
        setError(errorMessage);
        setIsInitialized(false);

        if (initializationAttempts.current < maxAttempts) {
          initializationAttempts.current++;
          const delay = Math.min(1000 * Math.pow(2, initializationAttempts.current), 5000);

          setTimeout(() => {
            if (mountedRef.current && container.isConnected) {
              initializeCard(container);
            }
          }, delay);
        } else {
          initializationAttempts.current = 0;
          if (onErrorRef.current) {
            onErrorRef.current(errorMessage);
          } else {
            if (errorMessage.includes('failed to load') || errorMessage.includes('not properly loaded')) {
              toast({
                title: "Square Environment Mismatch",
                description: "The payment form couldn't initialize due to a configuration mismatch. Please contact support for assistance.",
                variant: "destructive",
              });
            } else {
              toast({
                title: "Payment Form Notice",
                description: "Credit card payment form unavailable. Please try again or choose a different payment method.",
                variant: "default",
              });
            }
          }
        }
      }
    }
  }, [toast, cleanupCard]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (cardRef.current) {
        try {
          cardRef.current.destroy();
        } catch (e) {
          logger.error('useSquarePayment', 'Error during unmount cleanup', e);
        }
        cardRef.current = null;
      }
      initializingRef.current = false;
      resetSquarePayments();
    };
  }, []);

  return {
    card,
    isInitialized,
    error,
    initializeCard,
    cleanupCard,
  };
}
