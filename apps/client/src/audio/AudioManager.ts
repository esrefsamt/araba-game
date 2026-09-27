import {
  createEngineNoise,
  engineMix,
  remoteEngineMixScale,
  stepEngineAudio,
  type EngineAudioState,
} from './EngineAudioModel.js';

export type ArcadeAudioCue = 'countdown' | 'go' | 'round_end' | 'ui_click';

export class SoundSettingsState {
  private enabledValue = true;
  private volumeValue = 0.7;

  public get enabled(): boolean {
    return this.enabledValue;
  }

  public get volume(): number {
    return this.volumeValue;
  }

  public setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
  }

  public setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volumeValue = Math.min(1, Math.max(0, volume));
  }
}

interface EngineVoice {
  readonly oscillator: OscillatorNode;
  readonly overtone: OscillatorNode;
  readonly mechanical: AudioBufferSourceNode;
  readonly intake: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly overtoneGain: GainNode;
  readonly mechanicalGain: GainNode;
  readonly intakeGain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly output: GainNode;
  readonly nodes: readonly AudioNode[];
  state: EngineAudioState;
}

export interface RemoteEngineState {
  readonly playerId: string;
  readonly position: readonly [number, number, number];
  readonly speed: number;
}

/** Procedural, copyright-free Web Audio feedback. */
export class AudioManager {
  public readonly settings = new SoundSettingsState();
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private localEngine: EngineVoice | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly remoteEngines = new Map<string, EngineVoice>();
  private unlocked = false;

  public async unlock(): Promise<void> {
    if (typeof window === 'undefined') return;
    try {
      this.ensureContext();
      if (this.context?.state === 'suspended') await this.context.resume();
      this.unlocked = this.context?.state === 'running';
      if (this.unlocked && this.localEngine === null) {
        this.localEngine = this.createEngineVoice();
      }
      this.applyMasterGain();
    } catch {
      // Browsers can reject resume until a trusted gesture; the next gesture retries.
    }
  }

  public setEnabled(enabled: boolean): void {
    this.settings.setEnabled(enabled);
    this.applyMasterGain();
  }

  public toggleEnabled(): boolean {
    this.setEnabled(!this.settings.enabled);
    return this.settings.enabled;
  }

  public updateLocalEngine(
    speed: number,
    throttle: number,
    lateralSpeed: number,
    deltaSeconds = 1 / 60,
    braking = false,
    active = true,
  ): void {
    if (!this.unlocked || this.context === null || this.localEngine === null) return;
    this.updateVoice(
      this.localEngine,
      speed,
      throttle,
      braking,
      deltaSeconds,
      active ? 1 : 0,
    );
    if (active && Math.abs(lateralSpeed) > 3.5)
      this.playTireSkid(Math.abs(lateralSpeed) / 10);
  }

  public updateRemoteEngines(
    states: readonly RemoteEngineState[],
    listenerPosition: readonly [number, number, number],
    deltaSeconds = 1 / 60,
  ): void {
    if (!this.unlocked || this.context === null) return;
    const activeIds = new Set<string>();
    const nearby = states
      .slice(0, 7)
      .map((state) => ({
        state,
        distance: Math.hypot(
          state.position[0] - listenerPosition[0],
          state.position[1] - listenerPosition[1],
          state.position[2] - listenerPosition[2],
        ),
      }))
      .filter(({ distance }) => Number.isFinite(distance) && distance < 40);
    for (const { state, distance } of nearby) {
      activeIds.add(state.playerId);
      let voice = this.remoteEngines.get(state.playerId);
      if (voice === undefined) {
        voice = this.createEngineVoice();
        this.remoteEngines.set(state.playerId, voice);
      }
      this.updateVoice(
        voice,
        state.speed,
        Math.abs(state.speed) > 1 ? 0.35 : 0,
        false,
        deltaSeconds,
        remoteEngineMixScale(distance, nearby.length),
      );
    }
    for (const [playerId, voice] of this.remoteEngines) {
      if (activeIds.has(playerId)) continue;
      this.stopVoice(voice);
      this.remoteEngines.delete(playerId);
    }
  }

  public playCollision(strength: number): void {
    const amount = Math.min(1, Math.max(0, strength));
    if (amount < 0.08) return;
    this.playTone(
      95 + amount * 45,
      0.07 + amount * 0.13,
      0.025 + amount * 0.06,
      'triangle',
    );
  }

  public playRam(strength: number): void {
    const amount = Math.min(1, Math.max(0, strength));
    this.playTone(64 + amount * 28, 0.19, 0.08 + amount * 0.09, 'square', 48);
    this.playTone(180 + amount * 70, 0.09, 0.025 + amount * 0.035, 'sawtooth');
  }

  public playCue(cue: ArcadeAudioCue): void {
    if (cue === 'countdown') this.playTone(520, 0.09, 0.045, 'sine');
    else if (cue === 'go') this.playTone(780, 0.2, 0.065, 'triangle');
    else if (cue === 'round_end') this.playTone(280, 0.35, 0.065, 'triangle', 180);
    else this.playTone(440, 0.035, 0.022, 'sine');
  }

  public dispose(): void {
    if (this.localEngine !== null) this.stopVoice(this.localEngine);
    for (const voice of this.remoteEngines.values()) this.stopVoice(voice);
    this.remoteEngines.clear();
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.localEngine = null;
    this.noiseBuffer = null;
    this.unlocked = false;
  }

  private playTireSkid(strength: number): void {
    if (this.context === null || this.context.currentTime % 0.12 > 0.025) return;
    this.playTone(210 + strength * 60, 0.045, 0.008 + strength * 0.012, 'sawtooth');
  }

  private ensureContext(): void {
    if (this.context !== null) return;
    this.context = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    if (this.context === null || this.master === null) return;
    const gain = this.settings.enabled ? this.settings.volume : 0;
    this.master.gain.setTargetAtTime(gain, this.context.currentTime, 0.025);
  }

  private createEngineVoice(): EngineVoice {
    const context = this.context!;
    const master = this.master!;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    filter.Q.value = 0.55;
    const gain = context.createGain();
    gain.gain.value = 0;
    const overtoneGain = context.createGain();
    overtoneGain.gain.value = 0;
    const oscillator = context.createOscillator();
    // Rounded asymmetric firing pulse: rich at low frequencies without a saw/square buzz.
    oscillator.setPeriodicWave(
      context.createPeriodicWave(
        new Float32Array(7),
        new Float32Array([0, 1, 0.38, 0.17, 0.08, 0.035, 0.012]),
      ),
    );
    oscillator.frequency.value = 30;
    const overtone = context.createOscillator();
    overtone.type = 'triangle';
    overtone.frequency.value = 60;
    if (this.noiseBuffer === null) {
      const samples = createEngineNoise(context.sampleRate);
      this.noiseBuffer = context.createBuffer(1, samples.length, context.sampleRate);
      this.noiseBuffer.copyToChannel(samples, 0);
    }
    const mechanical = context.createBufferSource();
    const intake = context.createBufferSource();
    mechanical.buffer = intake.buffer = this.noiseBuffer;
    mechanical.loop = intake.loop = true;
    intake.playbackRate.value = 0.81;
    const mechanicalFilter = context.createBiquadFilter();
    mechanicalFilter.type = 'bandpass';
    mechanicalFilter.frequency.value = 220;
    mechanicalFilter.Q.value = 0.65;
    const intakeFilter = context.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.frequency.value = 410;
    intakeFilter.Q.value = 0.5;
    const mechanicalGain = context.createGain();
    mechanicalGain.gain.value = 0;
    const intakeGain = context.createGain();
    intakeGain.gain.value = 0;
    const firingEnvelope = context.createGain();
    firingEnvelope.gain.value = 0.65;
    const pulseDepth = context.createGain();
    pulseDepth.gain.value = 0.22;
    oscillator.connect(pulseDepth).connect(firingEnvelope.gain);
    mechanical
      .connect(mechanicalFilter)
      .connect(firingEnvelope)
      .connect(mechanicalGain)
      .connect(filter);
    intake.connect(intakeFilter).connect(intakeGain).connect(filter);
    oscillator.connect(gain).connect(filter);
    overtone.connect(overtoneGain).connect(filter);
    const output = context.createGain();
    output.gain.value = 0;
    filter.connect(output).connect(master);
    oscillator.start();
    overtone.start();
    mechanical.start();
    intake.start();
    return {
      oscillator,
      overtone,
      mechanical,
      intake,
      gain,
      overtoneGain,
      mechanicalGain,
      intakeGain,
      filter,
      output,
      nodes: [
        oscillator,
        overtone,
        mechanical,
        intake,
        gain,
        overtoneGain,
        mechanicalGain,
        intakeGain,
        filter,
        output,
        mechanicalFilter,
        intakeFilter,
        firingEnvelope,
        pulseDepth,
      ],
      state: { rpm: 900, load: 0, gear: 1 },
    };
  }

  private updateVoice(
    voice: EngineVoice,
    speed: number,
    throttle: number,
    braking: boolean,
    deltaSeconds: number,
    mixScale: number,
  ): void {
    const now = this.context!.currentTime;
    voice.state = stepEngineAudio(voice.state, speed, throttle, braking, deltaSeconds);
    const mix = engineMix(voice.state, now);
    // All audible parameters use exponential approach; shifts never reset oscillator phase.
    voice.oscillator.frequency.setTargetAtTime(mix.pulseHz, now, 0.07);
    voice.overtone.frequency.setTargetAtTime(mix.pulseHz * 2, now, 0.09);
    voice.gain.gain.setTargetAtTime(mix.bodyGain, now, 0.09);
    voice.overtoneGain.gain.setTargetAtTime(mix.harmonicGain, now, 0.1);
    voice.mechanicalGain.gain.setTargetAtTime(mix.mechanicalGain, now, 0.12);
    voice.intakeGain.gain.setTargetAtTime(mix.intakeGain, now, 0.12);
    voice.filter.frequency.setTargetAtTime(mix.cutoffHz, now, 0.12);
    voice.output.gain.setTargetAtTime(mixScale, now, 0.06);
  }

  private stopVoice(voice: EngineVoice): void {
    const now = this.context?.currentTime ?? 0;
    voice.output.gain.setTargetAtTime(0, now, 0.025);
    voice.oscillator.onended = () => {
      for (const node of voice.nodes) node.disconnect();
    };
    try {
      voice.oscillator.stop(now + 0.15);
      voice.overtone.stop(now + 0.15);
      voice.mechanical.stop(now + 0.15);
      voice.intake.stop(now + 0.15);
    } catch {
      // Voice may already be stopped during shutdown.
    }
  }

  private playTone(
    frequency: number,
    duration: number,
    gainValue: number,
    type: OscillatorType,
    endFrequency = frequency * 0.72,
  ): void {
    if (
      !this.unlocked ||
      !this.settings.enabled ||
      this.context === null ||
      this.master === null
    )
      return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, endFrequency),
      now + duration,
    );
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
}
