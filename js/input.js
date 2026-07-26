// ---- Keyboard + mouse input ----

// One notch of a mouse wheel is ~100 px of deltaY, delivered as a single event.
// A trackpad two-finger drag is a STREAM of much smaller ones — so counting
// Math.sign() per event, as this used to, spent a whole zoom step on each tick
// and slammed the boom into its clamp before the fingers had finished moving.
// Normalising to notches makes one physical gesture mean one amount of zoom on
// either device. deltaMode says what the numbers are: 0 px, 1 lines, 2 pages.
const notches = (e) =>
  (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY) / 100;

class Input {
  constructor() {
    this.keys = new Set();
    this.rpgMode = false;   // right button steers instead of attacking
    this.dragX = 0;         // accumulated right-drag, consumed per frame
    this.dragY = 0;
    this.wheelSteps = 0;    // accumulated wheel, in notches, consumed per frame
    this.zoomHome = false;  // ⌘0 / ctrl+0 — put the boom back where it started
    this.mouse = { x: 0, y: 0, left: false, right: false }; // x,y = NDC; the
    this.leftPressed = false;
    this.leftReleased = false;
    // touch controls (js/touch.js drives these): an analog move stick + a
    // held-attack flag. touchAim is the last stick direction, so the player
    // faces / strikes the way they're moving on a phone.
    this.touch = { active: false, mx: 0, mz: 0 };
    this.touchAttack = false;
    this.touchBlock = false;
    this.touchAim = { x: 0, z: -1 };
    // OS cursor is a normal free cursor — the player just faces wherever it is.

    this.keyHandlers = new Map();

    window.addEventListener('keydown', (e) => {
      // Space is the keyboard attack button — stop it scrolling the page
      if (e.code === 'Space' && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) e.preventDefault();
      if (e.repeat) return;
      // ⌘-anything is a browser shortcut, never a game key — and macOS does
      // not deliver keyup while ⌘ is held, so tracking the key at all would
      // leave it stuck down (⌘A used to walk the player left forever).
      if (e.metaKey) return;
      this.keys.add(e.code);
      // Ctrl combos still TRACK (Ctrl alone is the block button — see
      // blocking() — and blocking while walking has to keep working), but they
      // must not fire the one-shot bindings: Ctrl+C is copy, and it was
      // flipping the camera into the driver's seat.
      if (e.ctrlKey && !e.code.startsWith('Control')) return;
      const h = this.keyHandlers.get(e.code);
      if (h) h();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.left = false;
      this.mouse.right = false;
      this.leftPressed = false;
      this.leftReleased = false;
    });

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      // RPG mode: hold right button and drag to steer/look (WoW style).
      // With mouse-look ON and the pointer locked, EVERY mouse move steers.
      if (this.rpgMode && (this.mouse.right || (this.mouseLook && this.locked))) {
        this.dragX += e.movementX || 0;
        this.dragY += e.movementY || 0;
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = !!document.pointerLockElement;
    });
    // The wheel is the CAMERA's, not the browser's. This listener has to be
    // NON-passive to say so: a passive one cannot preventDefault, which is why
    // ctrl+wheel (and a trackpad pinch, which Chrome reports as exactly that)
    // was zooming the whole page instead of the game. Anything inside a
    // scrollable panel keeps its native scroll — the settings body scrolls,
    // the world does not.
    const SCROLLS = '.panel, .atc-set-body, #atc-set, [data-scroll]';
    window.addEventListener('wheel', (e) => {
      if (e.target.closest?.(SCROLLS)) return;  // real UI scrolling, hands off
      e.preventDefault();                       // no page zoom, no rubber-band
      // A trackpad pinch arrives as ctrl+wheel. Refusing the PAGE zoom is the
      // point; refusing the gesture is not — pinch is the most natural "bring
      // the camera closer" there is, so it feeds the boom like everything else,
      // just on its own scale (pinch deltas are ~10× finer than wheel notches).
      this.wheelSteps += e.ctrlKey ? e.deltaY * 0.1 : notches(e);
    }, { passive: false });
    // Safari sends pinches as gesture events instead of ctrl+wheel. Same deal:
    // the page must not zoom, the camera must. e.scale is cumulative for the
    // gesture, so the per-event ratio is what moves the boom.
    let gScale = 1;
    window.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = 1; },
      { passive: false });
    window.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      if (e.scale > 0 && gScale > 0) this.wheelSteps += Math.log(gScale / e.scale) * 12;
      gScale = e.scale;
    }, { passive: false });
    window.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });
    // ctrl/⌘ with +/− is the keyboard route to the same intent, and ⌘0 the
    // "put it back" — all three would zoom the browser, so they get refused and
    // handed to the camera instead. Doing nothing at all reads as a dead key.
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.wheelSteps -= 1; }
      else if (e.key === '-')             { e.preventDefault(); this.wheelSteps += 1; }
      else if (e.key === '0')             { e.preventDefault(); this.zoomHome = true; }
    }, { passive: false });
    window.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, .panel, .spell-slot, #minimap')) return; // don't attack through UI
      if (e.button === 0) { this.mouse.left = true; this.leftPressed = true; }
      if (e.button === 2) this.mouse.right = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        if (this.mouse.left) this.leftReleased = true;
        this.mouse.left = false;
      }
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  onKey(code, fn) { this.keyHandlers.set(code, fn); }

  get moveX() {
    if (this.touch.active) return this.touch.mx;
    return (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
           (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
  }
  get moveZ() {
    if (this.touch.active) return this.touch.mz;
    return (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) -
           (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0);
  }
  // Right-click remains a quick repeating attack in top-down mode. Left-click
  // is edge-tracked separately so holding and releasing can charge a strike.
  get quickAttack() { return !this.rpgMode && this.mouse.right; }
  // Hold the attack button (left mouse OR spacebar OR the on-screen button).
  get attackHeld() { return this.mouse.left || this.keys.has('Space') || this.touchAttack; }
  get block() {
    return this.touchBlock || this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('KeyV');
  }
  // Hold Shift to raise the target-lock reticle: the nearest unit to the
  // screen centre gets selected and single-target abilities snap onto it.
  get selecting() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  takeLeftPressed() {
    const pressed = this.leftPressed;
    this.leftPressed = false;
    return pressed;
  }

  takeLeftReleased() {
    const released = this.leftReleased;
    this.leftReleased = false;
    return released;
  }

  cancelCombat() {
    this.mouse.left = false;
    this.mouse.right = false;
    this.leftPressed = false;
    this.leftReleased = false;
  }

  takeDrag() {
    const d = { x: this.dragX, y: this.dragY };
    this.dragX = 0; this.dragY = 0;
    return d;
  }

  takeWheel() {
    const w = this.wheelSteps;
    this.wheelSteps = 0;
    return w;
  }

  takeZoomHome() {
    const h = this.zoomHome;
    this.zoomHome = false;
    return h;
  }
}

export const input = new Input();
