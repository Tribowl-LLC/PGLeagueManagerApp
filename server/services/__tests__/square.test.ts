import { describe, it, expect, beforeEach, vi } from 'vitest';

// v40+ flat-client SDK shape (task #603 / Phase 2 of #600). Resources
// live under singular lowercase getters (`customers`, `payments`, ...)
// and methods return the response body directly with no `.result`
// wrapper. The mock here mirrors that shape so the SquarePaymentProvider
// under test consumes the same fields it will see in production.
const mocks = vi.hoisted(() => {
  return {
    customers: {
      search: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    payments: {
      create: vi.fn(),
    },
    catalog: {
      list: vi.fn(),
      searchItems: vi.fn(),
    },
    cards: {
      create: vi.fn(),
      list: vi.fn(),
      disable: vi.fn(),
    },
    // Stable logger so pagination tests can assert that the safety
    // cap fired (`log.warn(...)`) on the same instance the
    // module-level `log` was bound to at import time.
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getLocationSquareConfig: vi.fn(),
  };
});

vi.mock('square', () => ({
  SquareClient: function () {
    return {
      customers: mocks.customers,
      payments: mocks.payments,
      catalog: mocks.catalog,
      cards: mocks.cards,
    };
  },
  SquareEnvironment: { Production: 'production', Sandbox: 'sandbox' },
  // Provide a constructable SquareError so production code's
  // `error instanceof SquareError` narrowing path can be exercised by
  // tests that want to simulate a Square-side failure.
  SquareError: class SquareError extends Error {
    statusCode?: number;
    body?: unknown;
    errors?: Array<{ category?: string; code?: string; detail?: string; field?: string }>;
    constructor(args: {
      message?: string;
      statusCode?: number;
      body?: unknown;
      errors?: Array<{ category?: string; code?: string; detail?: string; field?: string }>;
    } = {}) {
      super(args.message ?? 'SquareError');
      this.name = 'SquareError';
      this.statusCode = args.statusCode;
      this.body = args.body;
      this.errors = args.errors;
    }
  },
}));

vi.mock('../../storage', () => ({
  storage: {
    getLocationSquareConfig: (...args: unknown[]) => mocks.getLocationSquareConfig(...args),
  },
}));

vi.mock('../../logger', () => ({
  createLogger: () => mocks.log,
}));

const {
  SquarePaymentProvider,
  buildSquareIdempotencyKey,
  SQUARE_IDEMPOTENCY_MAX_LENGTH,
} = await import('../square-provider.js');

// Task #671: pin the idempotency-key contract shared by saveCardOnFile
// and createOrUpdateCustomer. Square's CreateCard / CreateCustomer
// endpoints both cap `idempotency_key` at 45 chars; the v40 SDK
// migration silently shipped a 64-char SHA-256 hex digest which broke
// every save-card call in production with `VALUE_TOO_LONG`. These
// tests fail loud if any future refactor pushes the key over the
// limit, drops the deterministic shape, or accidentally collapses
// distinct (sourceId, customerId) pairs onto the same key.
describe('buildSquareIdempotencyKey (task #671)', () => {
  it('produces a key at or under Square\'s 45-char idempotency_key cap', () => {
    const longSourceId = 'cnon:' + 'A'.repeat(200);
    const longCustomerId = 'CUST_' + 'B'.repeat(200);
    const key = buildSquareIdempotencyKey('lv-card', longSourceId, longCustomerId);
    expect(key.length).toBeLessThanOrEqual(SQUARE_IDEMPOTENCY_MAX_LENGTH);
    expect(SQUARE_IDEMPOTENCY_MAX_LENGTH).toBe(45);
  });

  it('is deterministic for identical inputs (so retries dedupe in Square\'s window)', () => {
    const a = buildSquareIdempotencyKey('lv-card', 'cnon:ABC', 'CUST123');
    const b = buildSquareIdempotencyKey('lv-card', 'cnon:ABC', 'CUST123');
    expect(a).toBe(b);
  });

  it('changes when any input changes (no cross-bowler / cross-card collisions)', () => {
    const base = buildSquareIdempotencyKey('lv-card', 'cnon:ABC', 'CUST123');
    expect(buildSquareIdempotencyKey('lv-card', 'cnon:XYZ', 'CUST123')).not.toBe(base);
    expect(buildSquareIdempotencyKey('lv-card', 'cnon:ABC', 'CUST999')).not.toBe(base);
    expect(buildSquareIdempotencyKey('lv-cust', 'cnon:ABC', 'CUST123')).not.toBe(base);
  });

  it('throws if the prefix would push the key over the cap (loud failure for refactors)', () => {
    const tooLongPrefix = 'x'.repeat(50);
    expect(() => buildSquareIdempotencyKey(tooLongPrefix, 'a', 'b')).toThrow(
      /exceeded 45 chars/,
    );
  });
});

describe('saveCardOnFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocationSquareConfig.mockResolvedValue({
      accessToken: 'EAAAEv-test-token',
      appId: 'sq0idp-test',
      locationId: 'LOC123',
    });
    mocks.cards.list.mockResolvedValue({ data: [] });
    mocks.cards.disable.mockResolvedValue({});
  });

  it('sends an idempotency_key ≤45 chars to Square so VALUE_TOO_LONG never fires', async () => {
    mocks.cards.create.mockResolvedValue({
      card: {
        id: 'card_1',
        last4: '4242',
        cardBrand: 'VISA',
        fingerprint: 'fingerprint-4242',
      },
    });
    const localProvider = new SquarePaymentProvider(1);
    const sourceId = 'cnon:CA4SEXAMPLEEXAMPLEEXAMPLE';
    const customerId = 'CUSTOMER_ID_ABC123XYZ';

    await localProvider.saveCardOnFile(sourceId, customerId);
    expect(mocks.cards.create).toHaveBeenCalledTimes(1);
    const firstBody = mocks.cards.create.mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(typeof firstBody.idempotencyKey).toBe('string');
    expect(firstBody.idempotencyKey.length).toBeLessThanOrEqual(45);

    // Same inputs → same key (retry dedupe contract on Square's side).
    await localProvider.saveCardOnFile(sourceId, customerId);
    const secondBody = mocks.cards.create.mock.calls[1]?.[0] as { idempotencyKey: string };
    expect(secondBody.idempotencyKey).toBe(firstBody.idempotencyKey);
  });

  it('disables a newly-created duplicate and returns the existing active card', async () => {
    mocks.cards.list.mockResolvedValue({
      data: [
        {
          id: 'card_existing',
          last4: '1530',
          cardBrand: 'MASTERCARD',
          fingerprint: 'fingerprint-1530',
          enabled: true,
        },
        {
          id: 'card_duplicate',
          last4: '1530',
          cardBrand: 'MASTERCARD',
          fingerprint: 'fingerprint-1530',
          enabled: true,
        },
      ],
    });
    mocks.cards.create.mockResolvedValue({
      card: {
        id: 'card_duplicate',
        last4: '1530',
        cardBrand: 'MASTERCARD',
        fingerprint: 'fingerprint-1530',
      },
    });
    const provider = new SquarePaymentProvider(1);

    const result = await provider.saveCardOnFile('cnon:new-token', 'customer-1');

    expect(result).toEqual({
      id: 'card_existing',
      last4: '1530',
      brand: 'MASTERCARD',
    });
    expect(mocks.cards.list).toHaveBeenCalledWith({
      customerId: 'customer-1',
      sortOrder: 'ASC',
    });
    expect(mocks.cards.create.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cards.list.mock.invocationCallOrder[0],
    );
    expect(mocks.cards.disable).toHaveBeenCalledOnce();
    expect(mocks.cards.disable).toHaveBeenCalledWith({ cardId: 'card_duplicate' });
  });

  it('retains a caller-provided durable operation key for CreateCard', async () => {
    const callerProvidedKey = ['test', 'card', 'save', 'key'].join('-');
    mocks.cards.create.mockResolvedValue({
      card: {
        id: 'card_operation_key',
        last4: '4242',
        cardBrand: 'VISA',
        fingerprint: 'fingerprint-operation-key',
      },
    });
    const localProvider = new SquarePaymentProvider(1);

    await localProvider.saveCardOnFile(
      'cnon:operation-source',
      'CUSTOMER_OPERATION_KEY',
      callerProvidedKey,
    );

    expect(mocks.cards.create).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: callerProvidedKey,
    }));
  });

  it('keeps a newly-created card when only a disabled match exists', async () => {
    mocks.cards.list.mockResolvedValue({
      data: [
        {
          id: 'card_removed',
          last4: '1530',
          cardBrand: 'MASTERCARD',
          fingerprint: 'fingerprint-1530',
          enabled: false,
        },
        {
          id: 'card_resaved',
          last4: '1530',
          cardBrand: 'MASTERCARD',
          fingerprint: 'fingerprint-1530',
          enabled: true,
        },
      ],
    });
    mocks.cards.create.mockResolvedValue({
      card: {
        id: 'card_resaved',
        last4: '1530',
        cardBrand: 'MASTERCARD',
        fingerprint: 'fingerprint-1530',
      },
    });
    const provider = new SquarePaymentProvider(1);

    const result = await provider.saveCardOnFile('cnon:replacement-token', 'customer-1');

    expect(result).toEqual({
      id: 'card_resaved',
      last4: '1530',
      brand: 'MASTERCARD',
    });
    expect(mocks.cards.disable).not.toHaveBeenCalled();
  });

  it('does not disable an idempotent retry that returns the existing card ID', async () => {
    mocks.cards.list.mockResolvedValue({
      data: [{
        id: 'card_existing',
        last4: '4242',
        cardBrand: 'VISA',
        fingerprint: 'fingerprint-4242',
        enabled: true,
      }],
    });
    mocks.cards.create.mockResolvedValue({
      card: {
        id: 'card_existing',
        last4: '4242',
        cardBrand: 'VISA',
        fingerprint: 'fingerprint-4242',
      },
    });
    const provider = new SquarePaymentProvider(1);

    const result = await provider.saveCardOnFile('cnon:retry-token', 'customer-1');

    expect(result?.id).toBe('card_existing');
    expect(mocks.cards.disable).not.toHaveBeenCalled();
  });

  it('concurrent saves converge on the same oldest fingerprint match', async () => {
    const oldestCard = {
      id: 'card_oldest',
      last4: '1530',
      cardBrand: 'MASTERCARD',
      fingerprint: 'fingerprint-1530',
      enabled: true,
    };
    const newerCard = {
      id: 'card_newer',
      last4: '1530',
      cardBrand: 'MASTERCARD',
      fingerprint: 'fingerprint-1530',
      enabled: true,
    };
    mocks.cards.create
      .mockResolvedValueOnce({ card: oldestCard })
      .mockResolvedValueOnce({ card: newerCard });
    // Both workers observe Square's same creation-ordered post-create list.
    mocks.cards.list.mockResolvedValue({ data: [oldestCard, newerCard] });
    const provider = new SquarePaymentProvider(1);

    const results = await Promise.all([
      provider.saveCardOnFile('cnon:concurrent-a', 'customer-1'),
      provider.saveCardOnFile('cnon:concurrent-b', 'customer-1'),
    ]);

    expect(results.map(result => result?.id)).toEqual(['card_oldest', 'card_oldest']);
    expect(mocks.cards.list).toHaveBeenCalledTimes(2);
    expect(mocks.cards.disable).toHaveBeenCalledOnce();
    expect(mocks.cards.disable).toHaveBeenCalledWith({ cardId: 'card_newer' });
  });
});

describe('card-list query compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocationSquareConfig.mockResolvedValue({
      accessToken: 'EAAAEv-test-token',
      appId: 'sq0idp-test',
      locationId: 'LOC123',
    });
    mocks.cards.list.mockResolvedValue({ data: [] });
    mocks.cards.disable.mockResolvedValue({});
  });

  it('sends an explicit sort order when listing cards on file', async () => {
    const provider = new SquarePaymentProvider(1);

    await provider.listCardsOnFile('customer-1');

    expect(mocks.cards.list).toHaveBeenCalledWith({
      customerId: 'customer-1',
      sortOrder: 'ASC',
    });
  });

  it('sends an explicit sort order for the disable-card ownership check', async () => {
    mocks.cards.list.mockResolvedValue({
      data: [{ id: 'card-1', enabled: true }],
    });
    const provider = new SquarePaymentProvider(1);

    await provider.disableCard('card-1', 'customer-1');

    expect(mocks.cards.list).toHaveBeenCalledWith({
      customerId: 'customer-1',
      sortOrder: 'ASC',
    });
    expect(mocks.cards.disable).toHaveBeenCalledWith({ cardId: 'card-1' });
  });
});

describe('Square Service', () => {
  let provider: InstanceType<typeof SquarePaymentProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLocationSquareConfig.mockResolvedValue({
      accessToken: 'EAAAEv-test-token',
      appId: 'sq0idp-test',
      locationId: 'LOC123',
    });
    provider = new SquarePaymentProvider(1);
  });

  describe('createOrUpdateCustomer', () => {
    it('should create a new customer when one does not exist', async () => {
      mocks.customers.search.mockResolvedValueOnce({
        customers: [],
      });

      mocks.customers.create.mockResolvedValueOnce({
        customer: {
          id: 'test-customer-id',
          givenName: 'John',
          familyName: 'Doe',
          emailAddress: 'john@example.com',
        },
      });

      const result = await provider.createOrUpdateCustomer('John Doe', 'john@example.com', null);

      expect(result).toEqual({
        id: 'test-customer-id',
        name: 'John Doe',
        email: 'john@example.com',
      });

      expect(mocks.customers.create).toHaveBeenCalledWith(
        expect.objectContaining({
          givenName: 'John',
          familyName: 'Doe',
          emailAddress: 'john@example.com',
        }),
      );
    });

    it('should update an existing customer', async () => {
      mocks.customers.search.mockResolvedValueOnce({
        customers: [
          {
            id: 'existing-customer-id',
            givenName: 'John',
            familyName: 'Doe',
            emailAddress: 'john@example.com',
          },
        ],
      });

      mocks.customers.update.mockResolvedValueOnce({
        customer: {
          id: 'existing-customer-id',
          givenName: 'John',
          familyName: 'Doe',
          emailAddress: 'john@example.com',
        },
      });

      const result = await provider.createOrUpdateCustomer('John Doe', 'john@example.com', null);

      expect(result).toEqual({
        id: 'existing-customer-id',
        name: 'John Doe',
        email: 'john@example.com',
      });

      // v40+ folds customerId into the request body (no positional arg).
      expect(mocks.customers.update).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: 'existing-customer-id',
        }),
      );
    });

    it('throws ProviderNotConfiguredError when no Square credentials configured (task #332)', async () => {
      mocks.getLocationSquareConfig.mockResolvedValue(null);
      const noCredsProvider = new SquarePaymentProvider(999);
      await expect(
        noCredsProvider.createOrUpdateCustomer('John Doe', 'john@example.com'),
      ).rejects.toMatchObject({
        name: 'ProviderNotConfiguredError',
        code: 'PROVIDER_NOT_CONFIGURED',
        locationId: 999,
      });
    });

    it('should handle API errors', async () => {
      mocks.customers.search.mockRejectedValueOnce(new Error('API Error'));

      await expect(
        provider.createOrUpdateCustomer('John Doe', 'john@example.com', null),
      ).rejects.toThrow('Failed to create/update Square customer: API Error');
    });
  });

  describe('processPayment', () => {
    it('should process payment successfully', async () => {
      mocks.payments.create.mockResolvedValueOnce({
        payment: {
          id: 'payment-id',
          status: 'COMPLETED',
          cardDetails: {
            card: {
              last4: '1234',
              cardBrand: 'VISA',
            },
          },
        },
      });

      const result = await provider.processPayment('source-id', 1000, false);

      expect(result).toEqual({
        id: 'payment-id',
        status: 'COMPLETED',
        card: {
          last4: '1234',
          brand: 'VISA',
        },
      });

      expect(mocks.payments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'source-id',
          amountMoney: {
            amount: BigInt(1000),
            currency: 'USD',
          },
        }),
      );
    });

    it('throws ProviderNotConfiguredError when no Square credentials configured (task #332)', async () => {
      mocks.getLocationSquareConfig.mockResolvedValue(null);
      const noCredsProvider = new SquarePaymentProvider(999);
      await expect(
        noCredsProvider.processPayment('source-id', 1000),
      ).rejects.toMatchObject({
        name: 'ProviderNotConfiguredError',
        code: 'PROVIDER_NOT_CONFIGURED',
        locationId: 999,
      });
    });
  });

  // Task #332: every Square wallet/customer/payment method that
  // previously returned `{ success: false }` or null when the
  // Square client wasn't configured now throws
  // ProviderNotConfiguredError, so the routes can map it to a
  // uniform 422 PROVIDER_NOT_CONFIGURED. The four read-only
  // methods (listCardsOnFile, getPayment, listCatalogCategories,
  // listCatalogItems) intentionally stay degraded — pinned below.
  describe('ProviderNotConfiguredError contract (task #332)', () => {
    let noCredsProvider: InstanceType<typeof SquarePaymentProvider>;

    beforeEach(() => {
      mocks.getLocationSquareConfig.mockResolvedValue(null);
      noCredsProvider = new SquarePaymentProvider(999);
    });

    const expectsPnce = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({
        name: 'ProviderNotConfiguredError',
        code: 'PROVIDER_NOT_CONFIGURED',
        locationId: 999,
      });

    it('processPayment throws PNCE', async () => {
      await expectsPnce(noCredsProvider.processPayment('src', 1000));
    });

    it('createOrderWithPayment throws PNCE', async () => {
      await expectsPnce(noCredsProvider.createOrderWithPayment('src', 1000, []));
    });

    it('refundPayment throws PNCE', async () => {
      await expectsPnce(noCredsProvider.refundPayment('pay-id', 1000));
    });

    it('saveCardOnFile throws PNCE', async () => {
      await expectsPnce(noCredsProvider.saveCardOnFile('src', 'cust'));
    });

    it('disableCard throws PNCE', async () => {
      await expectsPnce(noCredsProvider.disableCard('card-id', 'cust'));
    });

    it('createOrUpdateCustomer throws PNCE', async () => {
      await expectsPnce(noCredsProvider.createOrUpdateCustomer('John', 'j@x.com'));
    });

    it('deleteCustomer throws PNCE', async () => {
      await expectsPnce(noCredsProvider.deleteCustomer('cust-id'));
    });

    it('registerApplePayDomain throws PNCE (task #302 baseline)', async () => {
      await expectsPnce(noCredsProvider.registerApplePayDomain('example.com'));
    });

    // Read-only methods kept intentionally degraded — pin the
    // contract so a future refactor doesn't accidentally flip
    // them to throwing without revisiting their callers.
    it('listCardsOnFile stays degraded (returns [])', async () => {
      await expect(noCredsProvider.listCardsOnFile('cust')).resolves.toEqual([]);
    });

    it('getPayment stays degraded (returns null)', async () => {
      await expect(noCredsProvider.getPayment('pay-id')).resolves.toBeNull();
    });

    it('listCatalogCategories stays degraded (returns empty payload, truncated:false)', async () => {
      // Task #623: shape changed from `CatalogCategory[]` to
      // `{ categories, truncated }`. Pin both the empty list and
      // the explicit `truncated: false` so the route can forward
      // the flag without a Boolean fallback.
      await expect(noCredsProvider.listCatalogCategories()).resolves.toEqual({
        categories: [],
        truncated: false,
      });
    });

    it('listCatalogItems stays degraded (returns empty payload, truncated:false)', async () => {
      // Task #623: same shape change as listCatalogCategories above.
      await expect(noCredsProvider.listCatalogItems()).resolves.toEqual({
        items: [],
        truncated: false,
      });
    });
  });

  // Task #613: pre-#613, both branches of `listCatalogItems` (and the
  // unscoped first-page list inside `listCatalogCategories`) only ever
  // walked the first response page. Any organization whose Square
  // catalog grew past Square's default page size silently lost items
  // in the admin UI with no signal that more existed. These tests pin
  // that the cursor is now followed across pages and that a safety
  // cap fires before a stuck cursor can pin a request indefinitely.
  describe('catalog pagination (task #613)', () => {
    const itemObject = (id: string, name: string) => ({
      id,
      type: 'ITEM',
      itemData: { name, variations: [] },
    });

    const categoryObject = (id: string, name: string) => ({
      id,
      type: 'CATEGORY',
      isDeleted: false,
      categoryData: { name },
    });

    // `client.catalog.list` returns a Page<> wrapper whose cursor lives
    // at `page.response.cursor` (not directly on the page). The
    // production code reads it from there, so the mock must too.
    const listPage = (data: unknown[], cursor?: string) => ({
      data,
      response: { cursor },
    });

    it('listCatalogItems (no categoryId) follows the cursor across multiple pages', async () => {
      mocks.catalog.list
        .mockResolvedValueOnce(listPage([itemObject('a', 'A'), itemObject('b', 'B')], 'cursor-1'))
        .mockResolvedValueOnce(listPage([itemObject('c', 'C')], 'cursor-2'))
        .mockResolvedValueOnce(listPage([itemObject('d', 'D')], undefined));

      const result = await provider.listCatalogItems();

      expect(result.items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
      // Task #623: a fully-walked cursor must not flag the response
      // as truncated — the UI banner only fires on a real cap hit.
      expect(result.truncated).toBe(false);
      expect(mocks.catalog.list).toHaveBeenCalledTimes(3);
      expect(mocks.catalog.list).toHaveBeenNthCalledWith(1, { cursor: undefined, types: 'ITEM' });
      expect(mocks.catalog.list).toHaveBeenNthCalledWith(2, { cursor: 'cursor-1', types: 'ITEM' });
      expect(mocks.catalog.list).toHaveBeenNthCalledWith(3, { cursor: 'cursor-2', types: 'ITEM' });
      expect(mocks.log.warn).not.toHaveBeenCalled();
    });

    it('listCatalogItems (with categoryId) follows the cursor across multiple pages via searchItems', async () => {
      mocks.catalog.searchItems
        .mockResolvedValueOnce({ items: [itemObject('a', 'A')], cursor: 'cursor-1' })
        .mockResolvedValueOnce({ items: [itemObject('b', 'B')], cursor: 'cursor-2' })
        .mockResolvedValueOnce({ items: [itemObject('c', 'C')], cursor: undefined });

      const result = await provider.listCatalogItems('CAT-1');

      expect(result.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
      expect(result.truncated).toBe(false);
      expect(mocks.catalog.searchItems).toHaveBeenCalledTimes(3);
      expect(mocks.catalog.searchItems).toHaveBeenNthCalledWith(1, {
        categoryIds: ['CAT-1'],
        cursor: undefined,
      });
      expect(mocks.catalog.searchItems).toHaveBeenNthCalledWith(2, {
        categoryIds: ['CAT-1'],
        cursor: 'cursor-1',
      });
      expect(mocks.catalog.searchItems).toHaveBeenNthCalledWith(3, {
        categoryIds: ['CAT-1'],
        cursor: 'cursor-2',
      });
      expect(mocks.log.warn).not.toHaveBeenCalled();
    });

    it('listCatalogItems treats an empty-string cursor as end-of-pagination', async () => {
      // Some Square SDK responses report `cursor: ''` (rather than
      // omitting it) on the final page. The helper must not loop on
      // an empty string. Pre-helper, `catalog.list` already used
      // `|| undefined` to coerce; this pins that the new shared
      // helper preserves that behavior for both branches.
      mocks.catalog.list.mockResolvedValueOnce(listPage([itemObject('only', 'Only')], ''));

      const result = await provider.listCatalogItems();

      expect(result.items.map((i) => i.id)).toEqual(['only']);
      expect(result.truncated).toBe(false);
      expect(mocks.catalog.list).toHaveBeenCalledTimes(1);
    });

    it('listCatalogItems stops at the MAX_PAGES safety cap, logs a warning, and flags truncated:true (task #623)', async () => {
      // Simulate a stuck cursor — every page returns one item and
      // the same non-empty cursor. The helper must bail at the page
      // cap (20) instead of looping forever, AND surface
      // `truncated: true` so the admin UI (Task #623) can show the
      // "catalog too large to fully load" banner instead of
      // pretending the capped 20-item prefix is the whole catalog.
      mocks.catalog.list.mockImplementation(async () =>
        listPage([itemObject('x', 'X')], 'never-ending-cursor'),
      );

      const result = await provider.listCatalogItems();

      expect(result.items).toHaveLength(20);
      expect(result.truncated).toBe(true);
      expect(mocks.catalog.list).toHaveBeenCalledTimes(20);
      expect(mocks.log.warn).toHaveBeenCalledTimes(1);
      expect(mocks.log.warn.mock.calls[0]?.[0]).toMatch(/MAX_PAGES=20/);
    });

    it('listCatalogItems stops at the MAX_ITEMS safety cap, logs a warning, and flags truncated:true (task #623)', async () => {
      // Simulate huge pages (300 items each) with a non-empty cursor
      // on every page. The helper must bail once the accumulated
      // count crosses 5,000, regardless of how many pages remain,
      // and flag the response as truncated for the UI banner.
      const bigPage = Array.from({ length: 300 }, (_, i) => itemObject(`x-${i}`, `X${i}`));
      mocks.catalog.list.mockImplementation(async () =>
        listPage(bigPage, 'never-ending-cursor'),
      );

      const result = await provider.listCatalogItems();

      // 17 pages of 300 = 5100 items, which crosses the 5000 cap.
      expect(result.items.length).toBeGreaterThanOrEqual(5_000);
      expect(result.truncated).toBe(true);
      expect(mocks.log.warn).toHaveBeenCalledTimes(1);
      expect(mocks.log.warn.mock.calls[0]?.[0]).toMatch(/MAX_ITEMS=5000/);
    });

    it('listCatalogItems (with categoryId) flags truncated:true when searchItems hits the cap (task #623)', async () => {
      // The category-scoped branch goes through `catalog.searchItems`
      // rather than `catalog.list`. Pin that the truncated flag
      // surfaces from that branch too, otherwise the banner would
      // silently hide whenever an admin filters by category.
      mocks.catalog.searchItems.mockImplementation(async () => ({
        items: [itemObject('x', 'X')],
        cursor: 'never-ending-cursor',
      }));

      const result = await provider.listCatalogItems('CAT-1');

      expect(result.truncated).toBe(true);
      expect(mocks.catalog.searchItems).toHaveBeenCalledTimes(20);
      expect(mocks.log.warn).toHaveBeenCalledTimes(1);
      expect(mocks.log.warn.mock.calls[0]?.[0]).toMatch(/MAX_PAGES=20/);
    });

    it('listCatalogCategories also paginates through the cursor', async () => {
      mocks.catalog.list
        .mockResolvedValueOnce(listPage([categoryObject('cat-1', 'Cat One')], 'cursor-1'))
        .mockResolvedValueOnce(listPage([categoryObject('cat-2', 'Cat Two')], undefined));

      const result = await provider.listCatalogCategories();

      expect(result.categories.map((c) => c.id).sort()).toEqual(['cat-1', 'cat-2']);
      expect(result.truncated).toBe(false);
      expect(mocks.catalog.list).toHaveBeenCalledTimes(2);
      expect(mocks.catalog.list).toHaveBeenNthCalledWith(1, {
        cursor: undefined,
        types: 'CATEGORY',
      });
      expect(mocks.catalog.list).toHaveBeenNthCalledWith(2, {
        cursor: 'cursor-1',
        types: 'CATEGORY',
      });
      expect(mocks.log.warn).not.toHaveBeenCalled();
    });

    it('listCatalogCategories flags truncated:true when the cursor never empties (task #623)', async () => {
      // Categories rarely approach the cap in practice but the same
      // contract applies: if the safety cap fires, the response must
      // tell the caller so the admin UI can surface it.
      mocks.catalog.list.mockImplementation(async () =>
        listPage([categoryObject('c', 'C')], 'never-ending-cursor'),
      );

      const result = await provider.listCatalogCategories();

      expect(result.truncated).toBe(true);
      expect(mocks.log.warn).toHaveBeenCalledTimes(1);
      expect(mocks.log.warn.mock.calls[0]?.[0]).toMatch(/MAX_PAGES=20/);
    });
  });
});
