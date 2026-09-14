import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Exercise the application's real configuration and imports, including the
// Tailwind worker. Using an existing filename keeps Project Service enabled.
const eslint = new ESLint({ cache: false });
const pagePath = 'client/src/pages/not-found.tsx';

async function findings(code: string, filePath = pagePath) {
  const results = await eslint.lintText(code, { filePath });
  const messages = results.flatMap((result) => result.messages);
  expect(messages.filter((message) => message.fatal)).toEqual([]);
  return messages.filter((message) => message.ruleId?.startsWith('shadcn/'));
}

describe('design-system lint integration', () => {
  it.each([
    ['no-restyle', '<Button className="p-4" />'],
    ['no-raw-colors', '<div className="bg-pink-500" />'],
    ['no-arbitrary-values', '<div className="p-[13px]" />'],
    ['no-inline-styles', '<div style={{ padding: 13 }} />'],
    ['no-unknown-classes', '<div className="hovr:flex" />'],
    ['require-static-classes', '<Button className={getClasses()} />'],
  ])('rejects %s violations', async (rule, element) => {
    const messages = await findings(`
      import { Button } from '@/components/ui/button';
      export default function Example() { return ${element}; }
    `);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: `shadcn/${rule}`, severity: 2 }),
    ]));
  });

  it.each(['@/components/ui/button', '@components/ui/button', '@ui/button'])(
    'recognizes components imported through %s',
    async (alias) => {
      const messages = await findings(`
        import { Button as Action } from '${alias}';
        export default function Example() { return <Action className="bg-primary" />; }
      `);
      expect(messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ ruleId: 'shadcn/no-restyle' }),
      ]));
    },
  );

  it('accepts theme tokens, component variants, plugins, and complete conditional classes', async () => {
    expect(await findings(`
      import { Button } from '@/components/ui/button';
      import { cn } from '@/lib/utils';
      export default function Example({ wide }: { wide: boolean }) {
        return <div className="bg-background text-foreground prose animate-in">
          <Button variant="outline" size="sm" className={cn('mt-4', wide ? 'w-full' : 'w-auto')} />
        </div>;
      }
    `)).toEqual([]);
  });

  it('allows shared primitives to own spacing while still checking their colors and classes', async () => {
    const messages = await findings(`
      import { Button } from '@/components/ui/button';
      export const Example = () => <Button className="p-[13px] bg-pink-500 hovr:flex" />;
    `, 'client/src/components/ui/card.tsx');
    expect(messages.map((message) => message.ruleId)).toEqual(expect.arrayContaining([
      'shadcn/no-raw-colors', 'shadcn/no-unknown-classes',
    ]));
    expect(messages.map((message) => message.ruleId)).not.toContain('shadcn/no-restyle');
    expect(messages.map((message) => message.ruleId)).not.toContain('shadcn/no-arbitrary-values');
  });
});
