// The audio-thread end of the car voices: a thin wrapper that hands messages to
// CarMixer and asks it for sound. Everything worth reading is in carmixer.js.
//
// These files live in public/ and not in js/ because audioWorklet.addModule()
// loads a URL at run time: the bundler never sees it, so it has to be a file
// that is served as it stands, imports and all, in dev and in the built site.

import { CarMixer } from './carmixer.js';

class CarProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mixer = new CarMixer(sampleRate);
    this.port.onmessage = (e) => this.mixer.message(e.data);
  }

  process(_inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0];
    // a render quantum is 128 frames today; the loop is here for the day it is not
    for (let o = 0; o < L.length; o += 128) {
      const n = Math.min(128, L.length - o);
      this.mixer.process(o ? L.subarray(o) : L, o ? R.subarray(o) : R, n);
    }
    return true;
  }
}

registerProcessor('car-voices', CarProcessor);
