import type { FingerprintComponent, Page } from './wire.js';

/**
 * The tab's fingerprint, read once, under the component names FingerprintJS
 * gives them so FP-Agent's vectoriser reads the record
 * (`docs/research/agent-journey-correlation.md`, 15.4). It is read by this
 * package's own code: most components are what the browser reports as it
 * is, and so the same whoever reads them. Four are measured, and by this
 * package's own method, so their values are this package's and not
 * FingerprintJS's: `audio`, `fonts`, `fontPreferences` and `math`.
 *
 * Also read, as the software an agent runs on gives itself away:
 * `webdriver`, the window's and viewport's size, and the browser's
 * low-entropy client hints. Nothing here asks the browser for permission,
 * and nothing is read from the page itself.
 */

/** The candidate fonts: the ones FP-Agent's vectoriser has a column for. */
export const FONT_CANDIDATES = [
  'ARNO PRO',
  'Agency FB',
  'Arabic Typesetting',
  'Arial Unicode MS',
  'AvantGarde Bk BT',
  'BankGothic Md BT',
  'Batang',
  'Bitstream Vera Sans Mono',
  'Calibri',
  'Century',
  'Century Gothic',
  'Clarendon',
  'EUROSTILE',
  'Franklin Gothic',
  'Futura Bk BT',
  'Futura Md BT',
  'GOTHAM',
  'Gill Sans',
  'HELV',
  'Haettenschweiler',
  'Helvetica Neue',
  'Humanst521 BT',
  'Leelawadee',
  'Letter Gothic',
  'Levenim MT',
  'Lucida Bright',
  'Lucida Sans',
  'MS Mincho',
  'MS Outlook',
  'MS Reference Specialty',
  'MS UI Gothic',
  'MT Extra',
  'MYRIAD PRO',
  'Marlett',
  'Meiryo UI',
  'Menlo',
  'Microsoft Uighur',
  'Minion Pro',
  'Monotype Corsiva',
  'PMingLiU',
  'Pristina',
  'SCRIPTINA',
  'Segoe UI Light',
  'Serifa',
  'SimHei',
  'Small Fonts',
  'Staccato222 BT',
  'TRAJAN PRO',
  'Univers CE 55 Medium',
  'Vrinda',
  'ZWAdobeF',
  'sans-serif-thin',
] as const;

const BASE_FONTS = ['monospace', 'sans-serif', 'serif'] as const;
const PROBE_TEXT = 'mmMwWLliI0fiflO&1';
const PROBE_SIZE = '72px';

/** How long the audio probe may take before it is given up as a timeout. */
const AUDIO_TIMEOUT_MS = 1_000;

type Read = () => unknown;

/** A component read, or why not: an API the browser lacks, or one it refused. */
function component(read: Read): FingerprintComponent {
  try {
    const value = read();
    return value === undefined ? { error: 'unsupported' } : { value };
  } catch (error) {
    // A browser refuses what it guards (storage, canvas) with a DOMException.
    if (error instanceof DOMException) return { error: error.name };
    throw error;
  }
}

/** Whether the page matches a media query; undefined where it cannot ask. */
function media(window: Page, query: string): boolean | undefined {
  // Every browser has it; a DOM without layout may not.
  if (typeof window.matchMedia !== 'function') return undefined;
  return window.matchMedia(query).matches;
}

/** The first of a media feature's values the browser matches, or undefined. */
function matchedValue<Value extends string>(
  window: Page,
  feature: string,
  values: readonly Value[],
): Value | undefined {
  return values.find(
    (value) => media(window, `(${feature}: ${value})`) === true,
  );
}

function storageWorks(read: () => Storage): boolean {
  return read() instanceof Storage;
}

/** A 2D canvas, or null where the browser has none to give. */
function canvas2d(document: Document): CanvasRenderingContext2D | null {
  const canvas = document.createElement('canvas');
  // A DOM without a canvas implementation answers null.
  if (typeof canvas.getContext !== 'function') return null;
  return canvas.getContext('2d');
}

function widthOf(context: CanvasRenderingContext2D, family: string): number {
  context.font = `${PROBE_SIZE} ${family}`;
  return context.measureText(PROBE_TEXT).width;
}

/** The candidates whose text measures unlike each base font it falls back to. */
function fonts(document: Document): string[] | undefined {
  const context = canvas2d(document);
  if (context === null) return undefined;
  const base = BASE_FONTS.map((family) => widthOf(context, family));
  return FONT_CANDIDATES.filter((font) =>
    BASE_FONTS.some(
      (family, index) =>
        widthOf(context, `'${font}', ${family}`) !== base[index],
    ),
  );
}

/** The probe text's width in each of the browser's generic families. */
function fontPreferences(
  document: Document,
): Record<string, number> | undefined {
  const context = canvas2d(document);
  if (context === null) return undefined;
  return {
    apple: widthOf(context, '-apple-system'),
    default: widthOf(context, 'initial'),
    min: (() => {
      context.font = `1px sans-serif`;
      return context.measureText(PROBE_TEXT).width;
    })(),
    mono: widthOf(context, 'monospace'),
    sans: widthOf(context, 'sans-serif'),
    serif: widthOf(context, 'serif'),
    system: widthOf(context, 'system-ui'),
  };
}

/**
 * Math functions at fixed inputs, and the textbook formulas for the same
 * ("Pf"): engines differ in their last digits. The inputs are this
 * package's own.
 */
function math(): Record<string, number> {
  const x = 0.4375;
  const big = 100;
  return {
    acos: Math.acos(x),
    acosh: Math.acosh(big),
    acoshPf: Math.log(big + Math.sqrt(big * big - 1)),
    asin: Math.asin(x),
    asinh: Math.asinh(x),
    asinhPf: Math.log(x + Math.sqrt(x * x + 1)),
    atan: Math.atan(x),
    atanh: Math.atanh(x),
    atanhPf: Math.log((1 + x) / (1 - x)) / 2,
    cos: Math.cos(big),
    cosh: Math.cosh(x),
    coshPf: (Math.exp(x) + Math.exp(-x)) / 2,
    exp: Math.exp(x),
    expm1: Math.expm1(x),
    expm1Pf: Math.exp(x) - 1,
    log1p: Math.log1p(big),
    log1pPf: Math.log(1 + big),
    powPI: Math.PI ** -big,
    sin: Math.sin(big),
    sinh: Math.sinh(x),
    sinhPf: (Math.exp(x) - Math.exp(-x)) / 2,
    tan: Math.tan(-big),
    tanh: Math.tanh(x),
    tanhPf: (Math.exp(2 * x) - 1) / (Math.exp(2 * x) + 1),
  };
}

/** A sum over a rendered oscillator: audio stacks differ in what they compute. */
async function audio(window: Page): Promise<FingerprintComponent> {
  const Offline: unknown = Reflect.get(window, 'OfflineAudioContext');
  if (typeof Offline !== 'function') return { error: 'unsupported' };
  const context = new (Offline as typeof OfflineAudioContext)(1, 5_000, 44_100);
  const oscillator = context.createOscillator();
  oscillator.type = 'triangle';
  oscillator.frequency.value = 10_000;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -50;
  compressor.knee.value = 40;
  compressor.ratio.value = 12;
  compressor.attack.value = 0;
  compressor.release.value = 0.25;
  oscillator.connect(compressor);
  compressor.connect(context.destination);
  oscillator.start(0);
  // A background tab can leave the render suspended for good.
  const timeout = new Promise<null>((resolve) =>
    window.setTimeout(() => {
      resolve(null);
    }, AUDIO_TIMEOUT_MS),
  );
  const rendered = await Promise.race([context.startRendering(), timeout]);
  if (rendered === null) return { error: 'timeout' };
  const samples = rendered.getChannelData(0);
  let sum = 0;
  for (let index = 4_500; index < samples.length; index += 1)
    sum += Math.abs(samples[index] ?? 0);
  return { value: sum };
}

/** Every component, by name; the audio one waits on a render. */
export async function readFingerprint(
  window: Page,
): Promise<Record<string, FingerprintComponent>> {
  const { navigator, screen, document } = window;
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    oscpu?: string;
    userAgentData?: { brands: unknown; mobile: boolean; platform: string };
  };
  const components: Record<string, FingerprintComponent> = {
    colorDepth: component(() => screen.colorDepth),
    colorGamut: component(() =>
      matchedValue(window, 'color-gamut', ['rec2020', 'p3', 'srgb']),
    ),
    // As the other readers number them: more is 1, less -1, forced 10.
    contrast: component(() => {
      const preference = matchedValue(window, 'prefers-contrast', [
        'no-preference',
        'high',
        'more',
        'low',
        'less',
        'forced',
      ]);
      if (preference === undefined) return undefined;
      return {
        'no-preference': 0,
        high: 1,
        more: 1,
        low: -1,
        less: -1,
        forced: 10,
      }[preference];
    }),
    cookiesEnabled: component(() => navigator.cookieEnabled),
    deviceMemory: component(() => nav.deviceMemory),
    forcedColors: component(() => media(window, '(forced-colors: active)')),
    hardwareConcurrency: component(() => navigator.hardwareConcurrency),
    hdr: component(() => media(window, '(dynamic-range: high)')),
    // Absent where the page may not store anything (some private modes).
    indexedDB: component(() => 'indexedDB' in window),
    invertedColors: component(() =>
      matchedValue(window, 'inverted-colors', ['inverted', 'none']) ===
      undefined
        ? undefined
        : media(window, '(inverted-colors: inverted)'),
    ),
    localStorage: component(() => storageWorks(() => window.localStorage)),
    monochrome: component(() => {
      for (let bits = 0; bits <= 100; bits += 1)
        if (media(window, `(max-monochrome: ${String(bits)})`)) return bits;
      return undefined;
    }),
    openDatabase: component(() => Reflect.has(window, 'openDatabase')),
    platform: component(() => navigator.platform),
    reducedMotion: component(() =>
      media(window, '(prefers-reduced-motion: reduce)'),
    ),
    sessionStorage: component(() => storageWorks(() => window.sessionStorage)),
    timezone: component(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    osCpu: component(() => nav.oscpu),
    vendor: component(() => navigator.vendor),
    vendorFlavors: component(() =>
      ['chrome', 'safari', '__crWeb', '__gCrWeb'].filter((name) =>
        Reflect.has(window, name),
      ),
    ),
    fonts: component(() => fonts(document)),
    languages: component(() => [
      [navigator.language],
      [...navigator.languages],
    ]),
    plugins: component(() =>
      [...navigator.plugins].map((plugin) => ({
        // Deprecated with the plugin list itself, and the very value
        // FingerprintJS's plugins component reads.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        name: plugin.name,
      })),
    ),
    screenResolution: component(() => [screen.width, screen.height]),
    // Insets of the space the browser may use: top, right, bottom, left.
    screenFrame: component(() => {
      const frame = screen as Screen & {
        availTop?: number;
        availLeft?: number;
      };
      const top = frame.availTop ?? 0;
      const left = frame.availLeft ?? 0;
      return [
        top,
        screen.width - screen.availWidth - left,
        screen.height - screen.availHeight - top,
        left,
      ];
    }),
    touchSupport: component(() => ({
      maxTouchPoints: navigator.maxTouchPoints,
      touchEvent: 'TouchEvent' in window,
      touchStart: 'ontouchstart' in window,
    })),
    math: component(math),
    fontPreferences: component(() => fontPreferences(document)),
    webdriver: component(() => navigator.webdriver),
    window: component(() => [
      window.outerWidth,
      window.outerHeight,
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio,
    ]),
    userAgentData: component(() =>
      nav.userAgentData === undefined
        ? undefined
        : {
            brands: nav.userAgentData.brands,
            mobile: nav.userAgentData.mobile,
            platform: nav.userAgentData.platform,
          },
    ),
  };
  return { ...components, audio: await audio(window) };
}
