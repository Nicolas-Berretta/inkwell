/**
 * Input stabilisation for a stroke in progress.
 *
 * Raw pointer samples go in; clean `[x, y, width]` control points come out:
 *
 *   - positions are lightly low-passed to remove sensor jitter,
 *   - samples closer than a minimum screen distance to the last accepted
 *     point are dropped (near-duplicates only add noise to the spline),
 *   - width comes from real pen pressure when the device reports it and from
 *     pointer speed otherwise. The variation is deliberately modest (a
 *     ballpoint or felt tip, not a calligraphy nib), it is low-passed so it
 *     never flickers, and it may only change gradually along the stroke so
 *     there are no abrupt swells or pinched ends.
 *
 * Pure and DOM-free: callers pass plain numbers taken from `PointerEvent`s.
 */
import type { StrokeTool } from '../../types';
import { lowPass } from './smoothing';
import { round2 } from './strokeGeometry';

export interface InputSample {
  /** World-space position. */
  x: number;
  y: number;
  /** `PointerEvent.pressure` (0..1). */
  pressure: number;
  /** Timestamp in milliseconds. */
  time: number;
}

export interface StrokeInputOptions {
  tool: StrokeTool;
  /** Nominal stroke width in world units. */
  size: number;
  /** Camera zoom at the time of drawing; thresholds are defined in screen pixels. */
  zoom: number;
  /** `PointerEvent.pointerType`. */
  pointerType: string;
}

/** Minimum on-screen distance between accepted control points. */
const MIN_SCREEN_DISTANCE = 1.25;
/** Share of each new raw position blended into the stabilised position. */
const POSITION_FOLLOW = 0.65;
/** Share of each new target width blended into the stabilised width. */
const WIDTH_FOLLOW = 0.2;
/**
 * Largest width change between two control points, as a fraction of the
 * nominal size per screen pixel travelled.
 */
const WIDTH_SLOPE = 0.03;
/** Pointer speed (screen px / ms) at which the velocity-based width bottoms out. */
const FAST_SPEED = 2.2;
const SPEED_FOLLOW = 0.4;

const MIN_WIDTH_FACTOR = 0.6;
const MAX_WIDTH_FACTOR = 1.25;
/** Width factor a velocity-driven stroke opens with, before any speed is known. */
const START_WIDTH_FACTOR = 0.95;

/**
 * Mice report a constant 0.5 while a button is down and many touch screens
 * report 0 or 1, so only other values prove the device has a pressure sensor.
 */
export function isRealPressure(pointerType: string, pressure: number): boolean {
  return pointerType === 'pen' && pressure > 0 && pressure < 1 && pressure !== 0.5;
}

/** Width factor for a pressure reading: light touch is thin, full pressure is bold. */
export function pressureWidthFactor(pressure: number): number {
  const p = pressure < 0 ? 0 : pressure > 1 ? 1 : pressure;
  return clampFactor(0.6 + 0.65 * Math.pow(p, 0.9));
}

/** Width factor for a pointer speed in screen px/ms: slow is bold, fast is thin. */
export function velocityWidthFactor(speed: number): number {
  const v = speed <= 0 ? 0 : speed >= FAST_SPEED ? 1 : speed / FAST_SPEED;
  return clampFactor(1.08 - 0.3 * v);
}

function clampFactor(f: number): number {
  return f < MIN_WIDTH_FACTOR ? MIN_WIDTH_FACTOR : f > MAX_WIDTH_FACTOR ? MAX_WIDTH_FACTOR : f;
}

export class StrokeInputFilter {
  /** Accepted control points as flat `[x, y, width]` triples. */
  readonly points: number[] = [];

  private readonly minDistance: number;
  private smoothX = 0;
  private smoothY = 0;
  private lastTime = 0;
  private speed = 0;
  private width = 0;
  private usesPressure = false;
  private rawX = 0;
  private rawY = 0;
  private started = false;

  constructor(private readonly options: StrokeInputOptions) {
    this.minDistance = MIN_SCREEN_DISTANCE / options.zoom;
  }

  get count(): number {
    return this.points.length / 3;
  }

  /** Feeds one raw sample. Returns true when a new control point was accepted. */
  add(sample: InputSample): boolean {
    if (!this.started) {
      this.started = true;
      this.smoothX = sample.x;
      this.smoothY = sample.y;
      this.rawX = sample.x;
      this.rawY = sample.y;
      this.lastTime = sample.time;
      this.usesPressure = isRealPressure(this.options.pointerType, sample.pressure);
      this.width = this.options.size * this.targetFactor(sample.pressure, true);
      this.push(sample.x, sample.y);
      return true;
    }

    const prevX = this.smoothX;
    const prevY = this.smoothY;
    this.rawX = sample.x;
    this.rawY = sample.y;
    this.smoothX = lowPass(prevX, sample.x, POSITION_FOLLOW);
    this.smoothY = lowPass(prevY, sample.y, POSITION_FOLLOW);

    const dt = sample.time - this.lastTime;
    if (dt > 0) {
      const screenDistance = Math.hypot(this.smoothX - prevX, this.smoothY - prevY) * this.options.zoom;
      this.speed = lowPass(this.speed, screenDistance / dt, SPEED_FOLLOW);
      this.lastTime = sample.time;
    }
    if (!this.usesPressure && isRealPressure(this.options.pointerType, sample.pressure)) {
      this.usesPressure = true;
    }
    this.width = lowPass(this.width, this.options.size * this.targetFactor(sample.pressure, false), WIDTH_FOLLOW);

    const lastIndex = this.points.length - 3;
    const distance = Math.hypot(this.smoothX - this.points[lastIndex], this.smoothY - this.points[lastIndex + 1]);
    if (distance < this.minDistance) return false;
    this.push(this.smoothX, this.smoothY);
    return true;
  }

  /**
   * Ends the stroke. The low-pass filter trails the pointer slightly, so the
   * last raw position is appended to make the line end where the pointer was
   * actually lifted. Returns true when a point was added.
   */
  finish(): boolean {
    if (!this.started) return false;
    const lastIndex = this.points.length - 3;
    const distance = Math.hypot(this.rawX - this.points[lastIndex], this.rawY - this.points[lastIndex + 1]);
    if (distance < this.minDistance * 0.5) return false;
    this.push(this.rawX, this.rawY);
    return true;
  }

  private targetFactor(pressure: number, first: boolean): number {
    if (this.options.tool === 'highlighter') return 1;
    if (this.usesPressure) return pressureWidthFactor(pressure);
    // A stroke starts from rest, but opening at full "slow" width looks blobby.
    return first ? START_WIDTH_FACTOR : velocityWidthFactor(this.speed);
  }

  private push(x: number, y: number): void {
    let width = this.width;
    const lastIndex = this.points.length - 3;
    if (lastIndex >= 0) {
      const travelled = Math.hypot(x - this.points[lastIndex], y - this.points[lastIndex + 1]) * this.options.zoom;
      const limit = this.options.size * WIDTH_SLOPE * travelled;
      const previous = this.points[lastIndex + 2];
      if (width > previous + limit) width = previous + limit;
      else if (width < previous - limit) width = previous - limit;
    }
    this.points.push(round2(x), round2(y), round2(width));
  }
}
