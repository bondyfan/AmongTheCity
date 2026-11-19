// ---- peoplemat.js: how every person's surface meets the game's light --------
//
// One patch, shared by the lofted citizens of js/citizen.js and the downloaded
// humans of js/characters/: the sky wrap and the street light. It lives in a
// file of its own so that neither body has to import the other for it.
//
// THE SKY WRAP. A hemisphere light gives a vertical surface half of what it
// gives the pavement, and a person is nothing but vertical surfaces: in a
// building's shadow, and at night outside a lamp pool (the pools light the
// ground, not what stands on it), the figure went to a black cut-out against
// a lit street. The patch adds the scene's OWN sky colour as a little flat
// fill plus a rim where the surface turns away from the eye. It reads
// hemisphereLights[0], which sky.js drives from noon to midnight, so it is the
// same term by day (a faint bright edge, the way a figure outdoors really
// has one) and by night (a dim blue outline under the moon). Nothing here is
// emissive: with the hemisphere light off, a person is black.
//
// STREET LIGHT. With the post stack the composite lights a figure from the lamp
// map like everything else. Without it (the low preset) nothing did: a man
// under a lamp was a dark shape on a lit pavement. lampDirectPatch gives the
// material the same map to read on that path (js/lampmap.js).

import { lampDirectPatch } from './lampmap.js';

export const PEOPLE_KEY = 'citizen-skywrap-2-lamp';

/** The fragment half of the patch, for a shader object three hands to onBeforeCompile. */
export function peopleLight(sh) {
  sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
#if ( NUM_HEMI_LIGHTS > 0 ) && defined( RE_IndirectDiffuse )
	irradiance += hemisphereLights[ 0 ].skyColor * ( 0.10 + 0.85 * pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), 3.0 ) );
#endif`);
  lampDirectPatch(sh);
}

/** Patch a material in place (and key its program so three shares it). */
export function patchPeopleMaterial(mat, key = PEOPLE_KEY, more = null) {
  mat.onBeforeCompile = (sh) => { peopleLight(sh); more?.(sh); };
  mat.customProgramCacheKey = () => key;
  return mat;
}
