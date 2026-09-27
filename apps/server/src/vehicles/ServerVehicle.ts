import type RAPIER from '@dimforge/rapier3d-compat';
import { SIMULATION_TICK_RATE, WORLD_RESET_Y } from '@trailer-arena/shared';
import type {
  PlayerInputMessage,
  VehicleInputState,
  VehicleSpawnPoint,
  VehicleStateSnapshot,
} from '@trailer-arena/shared';

import { VehicleController } from './VehicleController.js';
import { NEUTRAL_VEHICLE_INPUT, sanitizeVehicleInput } from './VehicleInput.js';
import { VehicleRecovery } from './VehicleRecovery.js';
import type { SurfaceRegistry } from '../physics/SurfaceRegistry.js';
import { hasTrailerDeckScoringSupport } from '../gameplay/TrailerScoringSystem.js';

const ZERO_VECTOR = { x: 0, y: 0, z: 0 };

export class ServerVehicle {
  private readonly controller: VehicleController;
  private readonly recovery: VehicleRecovery;
  private readonly currentInput: VehicleInputState = { ...NEUTRAL_VEHICLE_INPUT };
  private lastInputSequence = -1;
  private controlsEnabled = true;

  public constructor(
    public readonly playerId: string,
    private readonly world: RAPIER.World,
    public readonly body: RAPIER.RigidBody,
    public readonly collider: RAPIER.Collider,
    private readonly spawnPoint: VehicleSpawnPoint,
    surfaces: SurfaceRegistry,
  ) {
    this.controller = new VehicleController(world, body, surfaces);
    this.recovery = new VehicleRecovery(world, body, collider);
    this.controller.setInput(this.currentInput);
  }

  public get input(): Readonly<VehicleInputState> {
    return this.currentInput;
  }

  public get inputSequence(): number {
    return this.lastInputSequence;
  }

  public get surfaceRelativeHorizontalSpeed(): number {
    return this.controller.currentSurfaceRelativeHorizontalSpeed;
  }

  public get hasTrailerDeckScoringSupport(): boolean {
    return hasTrailerDeckScoringSupport(
      this.controller.currentSurfaceType,
      this.controller.currentTrailerDeckContactCount,
    );
  }

  public get ramSlideGripMultiplier(): number {
    return this.controller.currentRamSlideGripMultiplier;
  }

  public get ramSlideRemainingSeconds(): number {
    return this.controller.currentRamSlideRemainingSeconds;
  }

  public get trailerAdhesionSuspended(): boolean {
    return this.controller.isNeutralSurfaceAdhesionSuspended;
  }

  public applyInput(message: PlayerInputMessage): boolean {
    if (!this.controlsEnabled) {
      return false;
    }
    if (message.sequence <= this.lastInputSequence) {
      return false;
    }

    const sanitized = sanitizeVehicleInput(message);
    this.currentInput.throttle = sanitized.throttle;
    this.currentInput.brake = sanitized.brake;
    this.currentInput.steering = sanitized.steering;
    this.currentInput.handbrake = sanitized.handbrake;
    this.lastInputSequence = message.sequence;
    return true;
  }

  public setControlsEnabled(enabled: boolean): void {
    this.controlsEnabled = enabled;
    if (!enabled) {
      this.currentInput.throttle = 0;
      this.currentInput.brake = 0;
      this.currentInput.steering = 0;
      this.currentInput.handbrake = false;
    }
    this.controller.setInput(enabled ? this.currentInput : NEUTRAL_VEHICLE_INPUT);
  }

  public update(deltaSeconds: number): void {
    this.controller.update(deltaSeconds);
    this.recovery.update(deltaSeconds);
  }

  public afterPhysicsStep(): void {
    this.controller.afterPhysicsStep(this.world.timestep);
    if (this.body.translation().y < WORLD_RESET_Y) {
      this.reset();
    }
  }

  public suspendTrailerAdhesion(durationSeconds: number): void {
    this.controller.suspendNeutralSurfaceAdhesion(durationSeconds);
  }

  public startRamSlide(): void {
    this.controller.startRamSlide();
  }

  public reset(): void {
    this.teleportTo(this.spawnPoint);
  }

  public teleportTo(spawnPoint: VehicleSpawnPoint): void {
    const [positionX, positionY, positionZ] = spawnPoint.position;
    const [rotationX, rotationY, rotationZ, rotationW] = spawnPoint.rotation;
    this.body.setTranslation({ x: positionX, y: positionY, z: positionZ }, true);
    this.body.setRotation(
      { x: rotationX, y: rotationY, z: rotationZ, w: rotationW },
      true,
    );
    this.body.setLinvel(ZERO_VECTOR, true);
    this.body.setAngvel(ZERO_VECTOR, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.controller.resetTransientState();
    this.recovery.resetState();
  }

  public selfRight(): boolean {
    return this.recovery.requestSelfRight();
  }

  public createSnapshot(): VehicleStateSnapshot {
    const position = this.body.translation();
    const rotation = this.body.rotation();
    const linearVelocity = this.body.linvel();
    const angularVelocity = this.body.angvel();
    return {
      playerId: this.playerId,
      lastProcessedInputSequence: this.lastInputSequence,
      position: [position.x, position.y, position.z],
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
      linearVelocity: [linearVelocity.x, linearVelocity.y, linearVelocity.z],
      angularVelocity: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
      forwardSpeed: this.controller.currentForwardSpeed,
      lateralSpeed: this.controller.currentLateralSpeed,
      grounded: this.controller.isGrounded,
      surfaceType: this.controller.currentSurfaceType,
      onTrailer: this.controller.isOnTrailerSurface,
      relativeForwardSpeed: this.controller.currentForwardSpeed,
      relativeLateralSpeed: this.controller.currentLateralSpeed,
      wheelContacts: this.controller.currentWheelContactCount,
      trailerDeckContacts: this.controller.currentTrailerDeckContactCount,
      trailerRelativePosition: [0, 0, 0],
      flipped: this.recovery.flipped,
      selfRightAvailable: this.recovery.available,
      ramSlideRemainingTicks: Math.ceil(
        this.controller.currentRamSlideRemainingSeconds * SIMULATION_TICK_RATE,
      ),
    };
  }

  public dispose(): void {
    this.controller.dispose();
    this.world.removeRigidBody(this.body);
  }
}
