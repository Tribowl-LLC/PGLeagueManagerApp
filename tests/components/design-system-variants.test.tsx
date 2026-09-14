import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { twMerge } from 'tailwind-merge';
import { CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const titleBefore = 'text-2xl font-semibold leading-none tracking-tight';
const labelBefore = 'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70';

function expectClasses(element: HTMLElement, classes: string) {
  expect([...element.classList].sort()).toEqual(classes.split(/\s+/).sort());
}

describe('design-system appearance preservation', () => {
  it('keeps the original heading defaults', () => {
    render(<CardTitle>Default heading</CardTitle>);
    expectClasses(screen.getByText('Default heading'), titleBefore);
  });

  it('preserves the line-height effect of an explicit heading size override', () => {
    render(<CardTitle size="lg">Section heading</CardTitle>);
    expectClasses(screen.getByText('Section heading'), twMerge(titleBefore, 'text-lg'));
  });

  it('distinguishes an explicit 2xl override from the default heading size', () => {
    render(<CardTitle size="2xl" weight="bold">Page heading</CardTitle>);
    expectClasses(screen.getByText('Page heading'), twMerge(titleBefore, 'text-2xl font-bold'));
  });

  it('keeps default labels and preserves explicit label-size overrides', () => {
    render(<><Label>Default label</Label><Label size="sm" weight="semibold">Payment recipient</Label></>);
    expectClasses(screen.getByText('Default label'), labelBefore);
    expectClasses(screen.getByText('Payment recipient'), twMerge(labelBefore, 'text-sm font-semibold'));
  });

  it('keeps compact badges at the existing 10px size', () => {
    render(<Badge size="compact">Count</Badge>);
    const badge = screen.getByText('Count');
    expect(badge).toHaveClass('text-[10px]', 'px-1.5', 'py-0');
    expect(badge).not.toHaveClass('text-xs');
  });

  it('preserves the background and interaction colors of destructive outline actions', () => {
    render(<Button variant="destructiveOutline">Remove</Button>);
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass(
      'bg-background', 'border-destructive', 'text-destructive',
      'hover:bg-destructive/10', 'hover:text-destructive',
    );
  });
});
