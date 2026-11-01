/**
 * Time-of-day CNY pricing for dsh-budget-guard-plugin.
 *
 * Pure functions only: no I/O, no LLM, no network. The Host loads the JSON
 * price tables and the Config holidays, then calls `priceMessage` once per
 * `assistant/message` with that event's own timestamp. A session that spans
 * peak and off-peak therefore sums per-message prices instead of repricing
 * history at render time.
 *
 * Time zone is fixed to Asia/Shanghai (UTC+08:00, no DST). Peak windows are
 * Monday–Friday 09:00–12:00 and 14:00–18:00, left-closed/right-open. Holidays
 * and weekends are off-peak.
 */

                                          

                            
                     
                    
                 
 

                             
                  
                     
 

                            
                                     
 

                            
                       
                        
                           
                       
 

                               
              
                   
                  
               
                 
                
                
                   
                          
                         
                       
                        
                    
                     
 

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOLIDAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DEFAULT_OFFPEAK_FACTOR = 0.5;

/** Built-in fallback table; official-prices.json and local-prices.json win. */
export const DEFAULT_PRICE_BOOK            = {
  models: {
    // Official DeepSeek list price (CNY / 1M tokens): input miss 2, input hit
    // 0.04, output 8. `offpeak` is the base tariff and `peak` is the 2× window,
    // which matches this plugin's peak/off-peak model. There is no separate
    // cache-write price: cache writes are part of the miss input.
    'deepseek-flash': {
      peak: { input_miss: 2, input_hit: 0.04, output: 8 },
      offpeak: { input_miss: 1, input_hit: 0.02, output: 4 },
    },
    'deepseek-v4-pro': {
      peak: { input_miss: 9, input_hit: 0.3, output: 27 },
      offpeak: { input_miss: 4.5, input_hit: 0.15, output: 13.5 },
    },
    'deepseek-chat': {
      peak: { input_miss: 2, input_hit: 0.2, output: 8 },
      offpeak: { input_miss: 1, input_hit: 0.1, output: 4 },
    },
    'deepseek-reasoner': {
      peak: { input_miss: 4, input_hit: 0.4, output: 6 },
      offpeak: { input_miss: 2, input_hit: 0.2, output: 3 },
    },
  },
};

/**
 * Conservative built-in holiday table. It is intentionally non-empty: a
 * missing or entirely invalid Config value must never silently bill a
 * statutory holiday at peak rates.
 */
export const DEFAULT_HOLIDAYS                    = [
  // 2024
  '2024-01-01',
  '2024-02-10', '2024-02-11', '2024-02-12', '2024-02-13', '2024-02-14', '2024-02-15', '2024-02-16', '2024-02-17',
  '2024-04-04', '2024-04-05', '2024-04-06',
  '2024-05-01', '2024-05-02', '2024-05-03', '2024-05-04', '2024-05-05',
  '2024-06-08', '2024-06-09', '2024-06-10',
  '2024-09-15', '2024-09-16', '2024-09-17',
  '2024-10-01', '2024-10-02', '2024-10-03', '2024-10-04', '2024-10-05', '2024-10-06', '2024-10-07',
  // 2025
  '2025-01-01',
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  '2025-04-04', '2025-04-05', '2025-04-06',
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  '2025-05-31', '2025-06-01', '2025-06-02',
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
  // 2026 (conservative schedule; overridable through Config)
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
];

function num(value         )         {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function validDateString(value        )          {
  const match = HOLIDAY_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Normalize a timestamp from a durable event.
 *
 * DSH writes epoch milliseconds, but a stored/replayed record may carry a
 * string. Strings with an explicit `Z` or `±HH:MM` are parsed as-is; a
 * timezone-less string is interpreted as Asia/Shanghai and warns, rather than
 * silently following the Host machine's local timezone.
 */
export function toEpochMs(value         , warn                            )                {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Epoch seconds are 10 digits; DSH writes 13-digit milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = `${text}T00:00:00+08:00`;
  let warned = false;
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    text = `${text}+08:00`;
    warned = true;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  if (warned) warn?.(`时间戳缺少时区，已按 Asia/Shanghai（+08:00）解释：${value}`);
  return parsed;
}

                                                         
                                        
                  
                     
 

/**
 * Resolve Config holidays. Empty/undefined/invalid input falls back to the
 * built-in table only when `useBuiltin` is true; setting the flag false makes
 * an empty list mean "no holidays". A partially valid list keeps the valid
 * dates and warns about the rest.
 */
export function normalizeHolidays(
  value         ,
  warn                            ,
  useBuiltin = true,
  currentYear = new Date(Date.now() + SHANGHAI_OFFSET_MS).getUTCFullYear(),
)                    {
  const warnings           = [];
  const dates = new Set        ();
  let invalid = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string' || !validDateString(item.trim())) {
        invalid += 1;
        if (warnings.length < 20) warnings.push(`节假日日期无效，已忽略：${String(item)}`);
        continue;
      }
      dates.add(item.trim());
    }
  } else if (value !== undefined && value !== null) {
    invalid += 1;
    warnings.push('holidays 不是数组，已忽略');
  }
  if (dates.size === 0) {
    if (!useBuiltin) {
      for (const warning of warnings) warn?.(warning);
      return { dates, source: 'none', invalid, warnings };
    }
    for (const date of DEFAULT_HOLIDAYS) dates.add(date);
    const maxYear = Math.max(...DEFAULT_HOLIDAYS.map((date) => Number(date.slice(0, 4))));
    if (currentYear > maxYear) {
      warnings.push(`内置节假日表只覆盖到 ${maxYear}，${currentYear} 年请通过 holidays 配置`);
    }
    for (const warning of warnings) warn?.(warning);
    return { dates, source: 'default', invalid, warnings };
  }
  for (const warning of warnings) warn?.(warning);
  return { dates, source: 'config', invalid, warnings };
}

/** Beijing wall-clock parts, read through the fixed +08:00 offset. */
function beijingParts(timestamp        )   
                  
               
                 
                 
               
         {
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return {
    weekday: date.getUTCDay(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    date: `${year}-${month}-${day}`,
  };
}

/**
 * Whether `timestamp` is in a weekday peak window. `null` means the timestamp
 * is invalid and the caller must skip that message (with a warning).
 */
export function isPeak(timestamp        , holidays                                         )                 {
  const parts = beijingParts(timestamp);
  if (!parts) return null;
  const set = holidays instanceof Set ? holidays : new Set(holidays);
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  if (set.has(parts.date)) return false;
  const minutes = parts.hour * 60 + parts.minute;
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

function tierFrom(value         )                     {
  if (!value || typeof value !== 'object') return {};
  const source = value                           ;
  const result                     = {};
  for (const key of ['input_miss', 'input_hit', 'output']         ) {
    const candidate = source[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) result[key] = candidate;
  }
  return result;
}

function cloneBook(book           )            {
  const models                             = {};
  for (const [model, entry] of Object.entries(book.models || {})) {
    models[model] = {
      peak: { ...entry.peak },
      offpeak: { ...entry.offpeak },
    };
  }
  return { models };
}

/**
 * Merge an external `{models:{...}}` table over a book. Later sources win per
 * field, so a local file can override just `output` for one model.
 */
export function mergePriceBooks(base           , overlay         )            {
  const result = cloneBook(base);
  if (!overlay || typeof overlay !== 'object') return result;
  const models = (overlay                        ).models;
  if (!models || typeof models !== 'object') return result;
  for (const [model, raw] of Object.entries(models                           )) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw                           ;
    const current = result.models[model] || {
      peak: { input_miss: 0, input_hit: 0, output: 0 },
      offpeak: { input_miss: 0, input_hit: 0, output: 0 },
    };
    result.models[model] = {
      peak: { ...current.peak, ...tierFrom(entry.peak) },
      offpeak: { ...current.offpeak, ...tierFrom(entry.offpeak) },
    };
  }
  return result;
}

                                     
                  
                     
 

/**
 * Fill missing fields. Missing `offpeak` values default to 50% of the merged
 * peak price. There is no separate cache-write price.
 */
export function finalizePriceBook(book           , offpeakFactor = DEFAULT_OFFPEAK_FACTOR)                     {
  const warnings           = [];
  const models                             = {};
  const factor = Number.isFinite(offpeakFactor) && offpeakFactor > 0 ? offpeakFactor : DEFAULT_OFFPEAK_FACTOR;
  for (const [model, entry] of Object.entries(book.models || {})) {
    const peakSource = entry.peak || ({}             );
    const offpeakSource = entry.offpeak || ({}             );
    const peak            = {
      input_miss: num(peakSource.input_miss),
      input_hit: num(peakSource.input_hit),
      output: num(peakSource.output),
    };
    if (!Number.isFinite(peakSource.input_miss)) warnings.push(`${model}: peak.input_miss 缺失，按 0 计`);
    if (!Number.isFinite(peakSource.input_hit)) warnings.push(`${model}: peak.input_hit 缺失，按 0 计`);
    if (!Number.isFinite(peakSource.output)) warnings.push(`${model}: peak.output 缺失，按 0 计`);
    const offpeak            = {
      input_miss: Number.isFinite(offpeakSource.input_miss) ? offpeakSource.input_miss : peak.input_miss * factor,
      input_hit: Number.isFinite(offpeakSource.input_hit) ? offpeakSource.input_hit : peak.input_hit * factor,
      output: Number.isFinite(offpeakSource.output) ? offpeakSource.output : peak.output * factor,
    };
    const missingOffpeak = ['input_miss', 'input_hit', 'output'].filter(
      (key) => !Number.isFinite(offpeakSource[key]),
    );
    if (missingOffpeak.length > 0) {
      warnings.push(`${model}: offpeak.${missingOffpeak.join('/')} 缺失，按 peak×${Math.round(factor * 100)}% 推算，请补价格表`);
    }
    models[model] = { peak, offpeak };
  }
  return { book: { models }, warnings };
}

function inputMissOf(usage           )         {
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const hit = num(usage.cacheReadTokens);
  const total = num(usage.totalTokens);
  // DSH providers report cache reads beside `inputTokens`, and `totalTokens`
  // also covers them. Other OpenAI-style providers include the cached prompt
  // inside inputTokens and set totalTokens = input + output. Detect the latter
  // before subtracting. Cache writes have no separate price: they are part of
  // the miss input, so `inputTokens` is billed as-is.
  const cacheIsSeparate = total <= 0 || total >= input + output + hit - 1;
  return cacheIsSeparate ? input : Math.max(0, input - hit);
}

/**
 * Price one assistant message at the time it actually happened.
 * On an invalid timestamp the caller must skip the message (no charge).
 */
export function priceMessage(input   
                   
                
                    
                                                    
                  
 )               {
  const model = typeof input.model === 'string' ? input.model : '';
  const peak = isPeak(input.timestamp, input.holidays);
  const inputMissTokens = inputMissOf(input.usage);
  const inputHitTokens = num(input.usage.cacheReadTokens);
  const outputTokens = num(input.usage.outputTokens);
  const base               = {
    ok: false,
    skipped: false,
    cost: 0,
    tier: peak ? 'peak' : 'offpeak',
    peak: peak === true,
    model,
    price: { input_miss: 0, input_hit: 0, output: 0 },
    inputMissTokens,
    inputHitTokens,
    outputTokens,
    unknownModel: false,
    missing: [],
    warnings: [],
  };
  if (peak === null) {
    return { ...base, skipped: true, reason: 'invalid-timestamp' };
  }
  const entry = input.book.models[model];
  if (!entry) {
    return { ...base, ok: true, unknownModel: true, reason: 'unknown-model' };
  }
  const tierName           = peak ? 'peak' : 'offpeak';
  const price = entry[tierName];
  const missing           = [];
  for (const key of ['input_miss', 'input_hit', 'output']         ) {
    if (!Number.isFinite(price[key])) missing.push(`${tierName}.${key}`);
  }
  const cost =
    (inputMissTokens / 1000000) * num(price.input_miss) +
    (inputHitTokens / 1000000) * num(price.input_hit) +
    (outputTokens / 1000000) * num(price.output);
  return {
    ...base,
    ok: true,
    tier: tierName,
    price: { ...price },
    cost,
    missing,
    warnings: missing.map((field) => `${model}: ${field} 缺失，按 0 计`),
  };
}
