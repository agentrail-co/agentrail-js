/** The part of jsdom's API the bundle test uses; jsdom ships no types. */
declare module 'jsdom' {
  export class JSDOM {
    constructor(
      html: string,
      options: { readonly url: string; readonly runScripts: 'dangerously' },
    );
    readonly window: Window & typeof globalThis;
  }
}
