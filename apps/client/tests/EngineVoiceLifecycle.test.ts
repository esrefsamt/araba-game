import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioManager } from '../src/audio/AudioManager.js';

class Parameter {
  public value = 0;
  public targets: number[] = [];
  public setTargetAtTime(value: number, time: number, constant: number) {
    if (![value, time, constant].every(Number.isFinite) || constant <= 0)
      throw new Error('Invalid audio automation');
    this.targets.push(value);
  }
  public setValueAtTime(value: number) {
    this.targets.push(value);
  }
  public exponentialRampToValueAtTime(value: number) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error('Invalid exponential ramp');
    this.targets.push(value);
  }
}

class Node {
  public gain = new Parameter();
  public frequency = new Parameter();
  public Q = new Parameter();
  public playbackRate = new Parameter();
  public onended: (() => void) | null = null;
  public started = false;
  public stopped = false;
  public disconnected = false;
  public loop = false;
  public buffer: unknown;
  public connect<T>(target: T): T {
    return target;
  }
  public disconnect() {
    this.disconnected = true;
  }
  public start() {
    this.started = true;
  }
  public stop() {
    this.stopped = true;
  }
  public setPeriodicWave() {
    /* mocked waveform storage is unnecessary */
  }
}

class Context {
  public state = 'suspended';
  public currentTime = 1;
  public sampleRate = 8000;
  public destination = new Node();
  public nodes: Node[] = [];
  public buffers = 0;
  public resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  public close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  public createGain() {
    return this.createNode();
  }
  public createOscillator() {
    return this.createNode();
  }
  public createBufferSource() {
    return this.createNode();
  }
  public createBiquadFilter() {
    return this.createNode();
  }
  public createPeriodicWave() {
    return {};
  }
  public createBuffer() {
    this.buffers += 1;
    return { copyToChannel() {} };
  }
  private createNode() {
    const node = new Node();
    this.nodes.push(node);
    return node;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('Web Audio engine graph lifecycle', () => {
  it('unlocks four layers once, preserves mute and reuses one noise buffer for eight players', async () => {
    const context = new Context();
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', function () {
      return context;
    });
    const audio = new AudioManager();
    audio.setEnabled(false);
    await audio.unlock();
    await audio.unlock();
    expect(context.state).toBe('running');
    expect(context.nodes.filter((node) => node.started)).toHaveLength(4);
    expect(context.nodes[0]!.gain.targets.at(-1)).toBe(0);
    audio.setEnabled(true);
    expect(context.nodes[0]!.gain.targets.at(-1)).toBe(0.7);
    audio.updateLocalEngine(NaN, Infinity, 0, NaN);
    audio.updateRemoteEngines(
      Array.from({ length: 10 }, (_, index) => ({
        playerId: `p${index}`,
        position: [index, 0, 0] as const,
        speed: 12,
      })),
      [0, 0, 0],
    );
    expect(context.nodes.filter((node) => node.started)).toHaveLength(32);
    expect(context.buffers).toBe(1);
    audio.setEnabled(false);
    const sourcesBeforeCue = context.nodes.filter((node) => node.started).length;
    audio.playCue('go');
    audio.playRam(1);
    audio.playCollision(1);
    expect(context.nodes.filter((node) => node.started)).toHaveLength(sourcesBeforeCue);
    audio.dispose();
    expect(context.state).toBe('closed');
    expect(
      context.nodes.filter((node) => node.started).every((node) => node.stopped),
    ).toBe(true);
  });

  it('fades and disconnects departed remote graphs, and skips distant players', async () => {
    const context = new Context();
    vi.stubGlobal('window', {});
    vi.stubGlobal('AudioContext', function () {
      return context;
    });
    const audio = new AudioManager();
    await audio.unlock();
    const localNodeCount = context.nodes.length;
    audio.updateRemoteEngines(
      [{ playerId: 'far', position: [100, 0, 0], speed: 20 }],
      [0, 0, 0],
    );
    expect(context.nodes.length).toBe(localNodeCount);
    audio.updateRemoteEngines(
      [{ playerId: 'near', position: [2, 0, 0], speed: 10 }],
      [0, 0, 0],
    );
    const remoteNodes = context.nodes.slice(localNodeCount);
    audio.updateRemoteEngines([], [0, 0, 0]);
    expect(remoteNodes.filter((node) => node.started).every((node) => node.stopped)).toBe(
      true,
    );
    for (const node of remoteNodes) node.onended?.();
    expect(remoteNodes.every((node) => node.disconnected)).toBe(true);
    audio.dispose();
  });
});
