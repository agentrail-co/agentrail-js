import { startFromTag } from './tag.js';

/** `agentrail.js`, the file the script tag loads: it starts from its own tag. */
const tag = document.currentScript;
if (tag instanceof HTMLScriptElement) startFromTag(tag);
