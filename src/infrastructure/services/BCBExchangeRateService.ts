import { ExchangeRate } from '../../domain/entities';
import { ExchangeRateService } from '../../domain/services';

interface OlindaResponse {
  value: Array<{
    cotacaoCompra: number;
    cotacaoVenda: number;
    dataHoraCotacao: string;
  }>;
}

interface SgsEntry {
  data: string;
  valor: string;
}

type SgsResponse = SgsEntry[];

interface CacheEntry {
  rate: ExchangeRate | null;
  timestamp: number;
}

interface ProviderOutcome {
  rate: ExchangeRate | null;
  /**
   * true  → provider answered authoritatively (200 with data, or 200 with empty list
   *         meaning "no PTAX for this day", e.g. weekend/holiday).
   * false → provider was unreachable (5xx, network, timeout, malformed JSON, etc.).
   *         Caller should fall back to another provider.
   */
  authoritative: boolean;
}

/**
 * Fetches USD/BRL PTAX from Banco Central do Brasil.
 *
 * Two providers are queried in order to tolerate outages of the primary one:
 *   1. Olinda (`olinda.bcb.gov.br`)  — official PTAX endpoint, returns cotacaoCompra/cotacaoVenda.
 *   2. SGS    (`api.bcb.gov.br`)     — fallback, exposes series 1 (venda) and 10813 (compra).
 *
 * The fallback was added because Olinda has been returning HTTP 503 for entire days
 * at a time, which previously caused the calculation service to incorrectly report
 * "PTAX não encontrada" for every operation.
 */
export class BCBExchangeRateService implements ExchangeRateService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly MAX_RETRIES = 3;
  private readonly TIMEOUT_MS = 5000;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly MAX_CACHE_SIZE = 1000;

  async getRate(fromCurrency: string, toCurrency: string, date: Date): Promise<ExchangeRate | null> {
    if (fromCurrency !== 'USD' || toCurrency !== 'BRL') {
      throw new Error(`Unsupported currency pair: ${fromCurrency}/${toCurrency}`);
    }

    const cacheKey = `${fromCurrency}-${toCurrency}-${date.toISOString().split('T')[0]}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.rate;
    }

    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.evictOldestEntries();
    }

    try {
      const rate = await this.fetchRateFromAnyProvider(date);
      this.cache.set(cacheKey, { rate, timestamp: Date.now() });
      return rate;
    } catch (error) {
      // Both providers were unreachable. Do NOT cache this — the caller is going to
      // walk back day by day looking for a PTAX, and we want each attempt to retry
      // when (and if) the BCB comes back online during the same session.
      // Surface the failure so the UI can distinguish "API down" from "no PTAX on this day".
      console.warn(
        `[BCBExchangeRateService] All providers unavailable for ${date.toISOString().split('T')[0]}:`,
        error
      );
      return null;
    }
  }

  private evictOldestEntries(): void {
    const entriesToRemove = Math.floor(this.cache.size * 0.2);
    const sortedEntries = Array.from(this.cache.entries()).sort(
      ([, a], [, b]) => a.timestamp - b.timestamp
    );

    for (let i = 0; i < entriesToRemove; i++) {
      const key = sortedEntries[i]?.[0];
      if (key) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Tries Olinda first, falls back to SGS if Olinda is unreachable.
   * Throws only when BOTH providers are unreachable. An authoritative "no PTAX
   * for this day" answer from either provider is returned as `null`.
   */
  private async fetchRateFromAnyProvider(date: Date): Promise<ExchangeRate | null> {
    const olinda = await this.fetchFromOlinda(date);
    if (olinda.authoritative) {
      return olinda.rate;
    }

    const sgs = await this.fetchFromSgs(date);
    if (sgs.authoritative) {
      return sgs.rate;
    }

    throw new Error(
      `Both BCB providers (Olinda and SGS) are unavailable for ${this.formatOlindaDate(date)}`
    );
  }

  private async fetchFromOlinda(date: Date): Promise<ProviderOutcome> {
    const dateStr = this.formatOlindaDate(date);
    const url =
      `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/` +
      `CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${dateStr}'&$format=json`;

    try {
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        // 404 is treated as authoritative "no data".
        if (response.status === 404) {
          return { rate: null, authoritative: true };
        }
        return { rate: null, authoritative: false };
      }

      const data = (await response.json()) as OlindaResponse;

      if (data.value && data.value.length > 0) {
        const rateData = data.value[0]!;
        // Art. 57 IN RFB 1.500/2014: uses cotacaoVenda for both bid and ask for tax purposes.
        return {
          rate: ExchangeRate.fromPTAX(rateData.cotacaoVenda, date),
          authoritative: true,
        };
      }

      // 200 OK with empty array → no PTAX for this day (weekend/holiday). Authoritative.
      return { rate: null, authoritative: true };
    } catch (_error) {
      return { rate: null, authoritative: false };
    }
  }

  private async fetchFromSgs(date: Date): Promise<ProviderOutcome> {
    const dateStr = this.formatSgsDate(date);
    // Série 1 = USD/BRL PTAX venda. We use it for both bid and ask, matching the
    // Olinda behaviour (Art. 57 IN RFB 1.500/2014).
    const url =
      `https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados?formato=json` +
      `&dataInicial=${dateStr}&dataFinal=${dateStr}`;

    try {
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        if (response.status === 404) {
          return { rate: null, authoritative: true };
        }
        return { rate: null, authoritative: false };
      }

      const data = (await response.json()) as SgsResponse;

      if (Array.isArray(data) && data.length > 0) {
        const entry = data[0]!;
        const value = Number(entry.valor);
        if (!Number.isFinite(value) || value <= 0) {
          return { rate: null, authoritative: false };
        }
        return { rate: ExchangeRate.fromPTAX(value, date), authoritative: true };
      }

      return { rate: null, authoritative: true };
    } catch (_error) {
      return { rate: null, authoritative: false };
    }
  }

  private async fetchWithRetry(url: string): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response) {
          throw new Error('Fetch returned null or undefined response');
        }

        // 4xx is not retriable; 5xx is retried with exponential backoff.
        if (response.ok || (response.status >= 400 && response.status < 500)) {
          return response;
        }

        throw new Error(`Request failed with status ${response.status}`);
      } catch (error) {
        lastError = error;

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Request timeout after ${this.TIMEOUT_MS}ms`);
        }

        if (attempt < this.MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
        }
      }
    }

    const errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Failed after ${this.MAX_RETRIES} retries: ${errorMessage}`);
  }

  /** Olinda expects MM-DD-YYYY. */
  private formatOlindaDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${month}-${day}-${year}`;
  }

  /** SGS expects DD/MM/YYYY. */
  private formatSgsDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
  }
}
