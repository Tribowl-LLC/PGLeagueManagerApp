import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/use-business-context', () => ({
  useBusinessContext: () => ({ business: null, isLoading: false }),
}));

import WelcomePage from '@/pages/welcome-page';

describe('public welcome page', () => {
  it('offers the two distinct entry paths before registration', () => {
    render(<WelcomePage />);

    expect(screen.getByRole('link', { name: /i need to register/i })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: /i have an account/i })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('img', { name: 'Perfect Game' })).toHaveAttribute('src', '/perfect-game-logo.png');
  });
});
