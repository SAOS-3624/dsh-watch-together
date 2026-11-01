/**
 * recognition-interface.js — the **recognition** side of the plugin.
 *
 * The watch loop needs three things from recognition: build one segment's
 * storyboard, format its manifest, and look up cached transcript sentences.
 * It must not know whether those come from dsh-video-storyboard, a local ASR
 * service, or a test double.
 *
 * This adapter is deliberately tiny; the important part is that callers depend
 * on this object instead of importing the storyboard package directly.
 */

export const RECOGNITION_INTERFACE_VERSION = 1;

/**
 * @param {{
 *   runStoryboard: (args: object) => Promise<object>,
 *   formatManifest: (result: object, options?: object) => string,
 *   cues?: (input: string) => Promise<object[]>|object[],
 * }} impl
 */
export function createRecognitionInterface(impl = {}) {
  const { runStoryboard, formatManifest, cues = async () => [] } = impl;
  if (typeof runStoryboard !== 'function') {
    throw new TypeError('recognition: runStoryboard(args) is required');
  }
  if (typeof formatManifest !== 'function') {
    throw new TypeError('recognition: formatManifest(result, options) is required');
  }
  return Object.freeze({
    kind: 'recognition',
    version: RECOGNITION_INTERFACE_VERSION,
    segment(args) {
      return runStoryboard(args);
    },
    manifest(result, options) {
      return formatManifest(result, options);
    },
    cues(input) {
      return cues(input);
    },
  });
}
