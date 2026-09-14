/**
 * Component test for the shared <WalletPaymentButtons /> (task #761).
 *
 * This component consolidates the previously-duplicated Apple Pay /
 * Google Pay wallet markup that lived inline in both the admin
 * record-payment dialog (`payment-credit-card-section`) and the bowler
 * setup card input (`payment-setup-card-input`). The behavior that must
 * be preserved across that consolidation:
 *   - The wallet mount nodes are ALWAYS rendered (so Square's
 *     `attach()` runs against a stable DOM node) but hidden via
 *     `display:none` until the corresponding `*Available` flag flips.
 *   - On wallets that only expose `tokenize()` (tokenize-only), the
 *     attach mount node is replaced by our own branded button.
 *   - Click + keyboard (Enter / Space) both invoke the handler only
 *     when the wallet is available.
 *   - The "processing wallet payment" affordance shows while a wallet
 *     charge is in flight.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WalletPaymentButtons } from '@/components/wallet-payment-buttons';

function renderButtons(overrides: Partial<React.ComponentProps<typeof WalletPaymentButtons>> = {}) {
  const onApplePayClick = vi.fn();
  const onGooglePayClick = vi.fn();
  const props: React.ComponentProps<typeof WalletPaymentButtons> = {
    variant: 'admin',
    applePayAvailable: false,
    googlePayAvailable: false,
    applePayRef: createRef<HTMLDivElement>(),
    googlePayRef: createRef<HTMLDivElement>(),
    onApplePayClick,
    onGooglePayClick,
    isWalletProcessing: false,
    applePayTokenizeOnly: false,
    googlePayTokenizeOnly: false,
    ...overrides,
  };
  render(<WalletPaymentButtons {...props} />);
  return { onApplePayClick, onGooglePayClick };
}

describe('<WalletPaymentButtons /> (#761)', () => {
  it('always mounts the attach nodes but hides them until available', () => {
    renderButtons({ applePayAvailable: false, googlePayAvailable: false });

    // Mount nodes exist even when neither wallet is available so
    // Square can attach() to a stable node...
    const apple = screen.getByTestId('wallet-apple-pay');
    const google = screen.getByTestId('wallet-google-pay');
    expect(apple).toBeInTheDocument();
    expect(google).toBeInTheDocument();

    // ...but they're hidden until the *Available flag flips.
    expect(apple).toHaveClass('hidden');
    expect(google).toHaveClass('hidden');
  });

  it('reveals the attach nodes once the wallets are available', () => {
    renderButtons({ applePayAvailable: true, googlePayAvailable: true });

    expect(screen.getByTestId('wallet-apple-pay')).not.toHaveClass('hidden');
    expect(screen.getByTestId('wallet-google-pay')).not.toHaveClass('hidden');
  });

  it('invokes the handlers on click and on Enter/Space only when available', async () => {
    const user = userEvent.setup();
    const { onApplePayClick, onGooglePayClick } = renderButtons({
      applePayAvailable: true,
      googlePayAvailable: true,
    });

    const apple = screen.getByTestId('wallet-apple-pay');
    await user.click(apple);
    expect(onApplePayClick).toHaveBeenCalledTimes(1);

    apple.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onApplePayClick).toHaveBeenCalledTimes(3);

    const google = screen.getByTestId('wallet-google-pay');
    await user.click(google);
    expect(onGooglePayClick).toHaveBeenCalledTimes(1);
  });

  it('does not wire handlers when the wallet is unavailable', async () => {
    const user = userEvent.setup();
    const { onApplePayClick } = renderButtons({ applePayAvailable: false });

    await user.click(screen.getByTestId('wallet-apple-pay'));
    expect(onApplePayClick).not.toHaveBeenCalled();
  });

  it('renders a branded fallback button for tokenize-only Apple Pay (no attach node)', async () => {
    const user = userEvent.setup();
    const { onApplePayClick } = renderButtons({
      applePayAvailable: true,
      applePayTokenizeOnly: true,
    });

    // The always-mounted attach node is NOT rendered in tokenize-only
    // mode (there's nothing to attach); our branded button stands in.
    expect(screen.queryByTestId('wallet-apple-pay')).not.toBeInTheDocument();
    const fallback = screen.getByTestId('wallet-apple-pay-tokenize');
    expect(fallback).toBeInTheDocument();

    await user.click(fallback);
    expect(onApplePayClick).toHaveBeenCalledTimes(1);
  });

  it('disables the tokenize-only fallback while a wallet charge is processing', () => {
    renderButtons({
      applePayAvailable: true,
      applePayTokenizeOnly: true,
      isWalletProcessing: true,
    });

    expect(screen.getByTestId('wallet-apple-pay-tokenize')).toBeDisabled();
  });

  it('shows the processing affordance only while a wallet charge is in flight', () => {
    renderButtons({ variant: 'bowler', applePayAvailable: true, isWalletProcessing: false });
    expect(screen.queryByTestId('wallet-processing')).not.toBeInTheDocument();

    cleanup();

    renderButtons({ variant: 'bowler', applePayAvailable: true, isWalletProcessing: true });
    expect(screen.getByTestId('wallet-processing')).toBeInTheDocument();
  });
});
