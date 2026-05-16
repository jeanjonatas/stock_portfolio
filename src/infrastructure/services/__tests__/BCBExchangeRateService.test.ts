import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BCBExchangeRateService } from '../BCBExchangeRateService';

type MockResponse = Partial<Response> & { json?: () => Promise<unknown> };
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<MockResponse>;

const olindaOk = (cotacaoVenda = 5.05): MockResponse => ({
  ok: true,
  status: 200,
  json: async () => ({
    value: [
      {
        cotacaoCompra: cotacaoVenda - 0.005,
        cotacaoVenda,
        dataHoraCotacao: '2023-01-15 13:00:00',
      },
    ],
  }),
});

const olindaEmpty = (): MockResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ value: [] }),
});

const olinda503 = (): MockResponse => ({
  ok: false,
  status: 503,
  json: async () => '',
});

const sgsOk = (valor = '5.3759'): MockResponse => ({
  ok: true,
  status: 200,
  json: async () => [{ data: '03/01/2023', valor }],
});

const sgsEmpty = (): MockResponse => ({
  ok: true,
  status: 200,
  json: async () => [],
});

const sgs503 = (): MockResponse => ({
  ok: false,
  status: 503,
  json: async () => '',
});

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
const isOlinda = (input: string | URL | Request): boolean =>
  urlOf(input).includes('olinda.bcb.gov.br');
const isSgs = (input: string | URL | Request): boolean =>
  urlOf(input).includes('api.bcb.gov.br/dados/serie');

describe('BCBExchangeRateService', () => {
  let service: BCBExchangeRateService;
  let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

  beforeEach(() => {
    service = new BCBExchangeRateService();
    fetchMock = vi.fn<FetchFn>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the Olinda rate when it responds with data', async () => {
    fetchMock.mockResolvedValueOnce(olindaOk(5.05));

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-15'));

    expect(rate).not.toBeNull();
    expect(rate?.fromCurrency).toBe('USD');
    expect(rate?.toCurrency).toBe('BRL');
    expect(rate?.bidRate).toBe(5.05);
    expect(rate?.askRate).toBe(5.05);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/olinda\.bcb\.gov\.br/);
  });

  it('rejects unsupported currency pairs synchronously', async () => {
    await expect(service.getRate('EUR', 'BRL', new Date('2023-01-15'))).rejects.toThrow(
      'Unsupported currency pair: EUR/BRL'
    );
  });

  it('caches successful Olinda results', async () => {
    fetchMock.mockResolvedValueOnce(olindaOk(5.05));

    const date = new Date('2023-01-15');
    const rate1 = await service.getRate('USD', 'BRL', date);
    const rate2 = await service.getRate('USD', 'BRL', date);

    expect(rate1).not.toBeNull();
    expect(rate2).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when Olinda authoritatively reports no PTAX (200 + empty list)', async () => {
    fetchMock.mockResolvedValueOnce(olindaEmpty());

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-15'));

    expect(rate).toBeNull();
    // Should NOT have hit SGS — Olinda was authoritative.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when Olinda returns 404 (treated as authoritative)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-15'));

    expect(rate).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to SGS when Olinda returns 503 on every retry', async () => {
    fetchMock.mockImplementation((url) => {
      if (isOlinda(url)) return Promise.resolve(olinda503());
      if (isSgs(url)) return Promise.resolve(sgsOk('5.3759'));
      return Promise.reject(new Error(`Unexpected URL ${urlOf(url)}`));
    });

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-03'));

    expect(rate).not.toBeNull();
    expect(rate?.bidRate).toBe(5.3759);
    expect(rate?.askRate).toBe(5.3759);

    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    // 3 retries on Olinda + 1 successful SGS call.
    expect(calledUrls.filter(isOlinda)).toHaveLength(3);
    expect(calledUrls.filter(isSgs)).toHaveLength(1);
  });

  it('falls back to SGS when Olinda throws a network error', async () => {
    fetchMock.mockImplementation((url) => {
      if (isOlinda(url)) return Promise.reject(new Error('Network error'));
      if (isSgs(url)) return Promise.resolve(sgsOk('5.3759'));
      return Promise.reject(new Error(`Unexpected URL ${urlOf(url)}`));
    });

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-03'));

    expect(rate?.bidRate).toBe(5.3759);
  });

  it('returns null without caching when both providers are unreachable', { timeout: 30_000 }, async () => {
    fetchMock.mockImplementation((url) => {
      if (isOlinda(url)) return Promise.resolve(olinda503());
      if (isSgs(url)) return Promise.resolve(sgs503());
      return Promise.reject(new Error(`Unexpected URL ${urlOf(url)}`));
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const date = new Date('2023-01-03');
    const rate1 = await service.getRate('USD', 'BRL', date);
    expect(rate1).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    // A second call must retry (failure was NOT cached), so the BCB has a chance
    // to recover during the same user session.
    const callsBefore = fetchMock.mock.calls.length;
    const rate2 = await service.getRate('USD', 'BRL', date);
    expect(rate2).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);

    warnSpy.mockRestore();
  });

  it('returns SGS data when Olinda is down and SGS reports the rate', async () => {
    fetchMock.mockImplementation((url) => {
      if (isOlinda(url)) return Promise.resolve(olinda503());
      if (isSgs(url)) return Promise.resolve(sgsOk('5.40'));
      return Promise.reject(new Error(`Unexpected URL ${urlOf(url)}`));
    });

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-04'));

    expect(rate?.bidRate).toBe(5.4);
  });

  it('returns null when Olinda is down and SGS authoritatively has no data', async () => {
    fetchMock.mockImplementation((url) => {
      if (isOlinda(url)) return Promise.resolve(olinda503());
      if (isSgs(url)) return Promise.resolve(sgsEmpty());
      return Promise.reject(new Error(`Unexpected URL ${urlOf(url)}`));
    });

    const rate = await service.getRate('USD', 'BRL', new Date('2023-01-07'));

    expect(rate).toBeNull();
  });

  it('uses MM-DD-YYYY for Olinda and DD/MM/YYYY for SGS', async () => {
    fetchMock.mockImplementation((url) => {
      if (isOlinda(url)) return Promise.resolve(olinda503());
      if (isSgs(url)) return Promise.resolve(sgsOk('5.0'));
      return Promise.reject(new Error(`Unexpected URL ${urlOf(url)}`));
    });

    await service.getRate('USD', 'BRL', new Date(2023, 0, 5)); // January 5, 2023

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    const olindaCall = urls.find(isOlinda);
    const sgsCall = urls.find(isSgs);

    expect(olindaCall).toBeDefined();
    expect(sgsCall).toBeDefined();
    expect(olindaCall).toContain("'01-05-2023'");
    expect(sgsCall).toContain('dataInicial=05/01/2023');
    expect(sgsCall).toContain('dataFinal=05/01/2023');
  });

  it('caches authoritative null results to avoid re-querying weekends/holidays', async () => {
    fetchMock.mockResolvedValue(olindaEmpty());

    const date = new Date('2023-01-15'); // Sunday
    const rate1 = await service.getRate('USD', 'BRL', date);
    const rate2 = await service.getRate('USD', 'BRL', date);

    expect(rate1).toBeNull();
    expect(rate2).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('respects cache TTL', async () => {
    fetchMock.mockResolvedValue(olindaOk(5.05));

    const originalDateNow = Date.now;
    let currentTime = 1_000_000;
    Date.now = vi.fn(() => currentTime);

    try {
      const date = new Date('2023-01-15');
      await service.getRate('USD', 'BRL', date);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      currentTime += 1000;
      await service.getRate('USD', 'BRL', date);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      currentTime += 24 * 60 * 60 * 1000 + 1000;
      await service.getRate('USD', 'BRL', date);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = originalDateNow;
    }
  });
});
