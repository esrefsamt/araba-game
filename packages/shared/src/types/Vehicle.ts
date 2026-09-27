export type Vector3Tuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

export interface VehicleInputState {
  throttle: number;
  brake: number;
  steering: number;
  handbrake: boolean;
}

export type SurfaceType = 'AIR' | 'GROUND' | 'TRAILER_DECK' | 'TRAILER_RAMP';

export interface VehicleStateSnapshot {
  playerId: string;
  lastProcessedInputSequence: number;
  position: Vector3Tuple;
  rotation: QuaternionTuple;
  linearVelocity: Vector3Tuple;
  angularVelocity: Vector3Tuple;
  forwardSpeed: number;
  lateralSpeed: number;
  grounded: boolean;
  surfaceType: SurfaceType;
  onTrailer: boolean;
  relativeForwardSpeed: number;
  relativeLateralSpeed: number;
  wheelContacts: number;
  trailerDeckContacts: number;
  trailerRelativePosition: Vector3Tuple;
  flipped: boolean;
  selfRightAvailable: boolean;
  ramSlideRemainingTicks: number;
}
