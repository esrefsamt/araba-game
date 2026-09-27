export type InfieldZone = 'SERVICE' | 'CONTROL' | 'PADDOCK' | 'RECOVERY' | 'ACCESS';
export type InfieldGeometry = 'box' | 'cylinder' | 'canopy' | 'sign';

/** Every solid collider is the same simplified primitive that the client draws. */
export interface InfieldElement {
  readonly id: string;
  readonly zone: InfieldZone;
  readonly geometry: InfieldGeometry;
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly yaw: number;
  readonly color: number;
  readonly collision: boolean;
  readonly text?: string;
}

export function getInfieldTransform(element: InfieldElement) {
  return {
    position: element.position,
    rotation: [0, Math.sin(element.yaw / 2), 0, Math.cos(element.yaw / 2)] as const,
    size: element.size,
  };
}

function createLayout(): readonly InfieldElement[] {
  const elements: InfieldElement[] = [];
  const add = (
    id: string,
    zone: InfieldZone,
    geometry: InfieldGeometry,
    position: InfieldElement['position'],
    size: InfieldElement['size'],
    color: number,
    collision = false,
    yaw = 0,
    text?: string,
  ) => {
    elements.push({
      id,
      zone,
      geometry,
      position,
      size,
      color,
      collision,
      yaw,
      ...(text === undefined ? {} : { text }),
    });
  };
  const sign = (
    id: string,
    zone: InfieldZone,
    text: string,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    yaw = 0,
  ) =>
    add(id, zone, 'sign', [x, y, z], [width, height, 0.025], 0xeac06a, false, yaw, text);
  const vehicle = (
    id: string,
    zone: InfieldZone,
    x: number,
    z: number,
    size: InfieldElement['size'],
    color: number,
    yaw = 0,
  ) => {
    const [width, height, length] = size;
    add(id, zone, 'box', [x, height / 2, z], size, color, true, yaw);
    // Surface-mounted glazing and wheel details only slightly protrude from the body.
    add(
      `${id}-glass`,
      zone,
      'box',
      [x, height * 0.75, z + length * 0.2],
      [width + 0.02, height * 0.25, length * 0.3],
      0x526e7b,
      false,
      yaw,
    );
    for (const side of [-1, 1])
      for (const axle of [-1, 1])
        add(
          `${id}-wheel-${side}-${axle}`,
          zone,
          'box',
          [x + side * width * 0.5, 0.38, z + axle * length * 0.32],
          [0.08, 0.7, 0.7],
          0x26343b,
        );
  };
  const tires = (id: string, zone: InfieldZone, x: number, z: number) => {
    add(id, zone, 'cylinder', [x, 0.72, z], [1.18, 1.44, 1.18], 0x293238, true);
    for (let tier = 1; tier < 4; tier += 1)
      add(
        `${id}-seam-${tier}`,
        zone,
        'cylinder',
        [x, tier * 0.36, z],
        [1.2, 0.035, 1.2],
        0x52616a,
      );
  };
  const crate = (id: string, zone: InfieldZone, x: number, z: number, width = 1.6) => {
    add(id, zone, 'box', [x, 0.65, z], [width, 1.3, 1.3], 0xb69b70, true);
    add(`${id}-band`, zone, 'box', [x, 0.66, z], [width + 0.02, 0.12, 1.32], 0x58616a);
  };
  const cone = (id: string, zone: InfieldZone, x: number, z: number) => {
    add(id, zone, 'box', [x, 0.04, z], [0.45, 0.08, 0.45], 0x27383d);
    add(`${id}-top`, zone, 'canopy', [x, 0.29, z], [0.36, 0.5, 0.36], 0xe18f4f);
  };

  // Surfaces remain cosmetic: no new grip type or raised collision seams.
  add('service-pad', 'SERVICE', 'box', [-26, 0.023, -14], [29, 0.03, 12], 0x596165);
  add('control-pad', 'CONTROL', 'box', [-26, 0.024, 11], [25, 0.03, 20], 0x818481);
  add('paddock-pad', 'PADDOCK', 'box', [25, 0.024, 13], [29, 0.03, 16], 0xb7b5a7);
  add('recovery-pad', 'RECOVERY', 'box', [27, 0.023, -15], [15, 0.03, 11], 0xaf987c);
  add('cross-service-road', 'ACCESS', 'box', [0, 0.042, -6], [80, 0.025, 4], 0x62696a);
  add('west-access-lane', 'ACCESS', 'box', [-38, 0.043, 4], [4, 0.025, 24], 0x62696a);
  add('east-access-lane', 'ACCESS', 'box', [38, 0.043, -0.5], [4, 0.025, 15], 0x62696a);
  add('team-access-lane', 'ACCESS', 'box', [24, 0.044, 3], [28, 0.025, 3.5], 0x62696a);
  for (let index = 0; index < 14; index += 1)
    add(
      `road-dash-${index}`,
      'ACCESS',
      'box',
      [-37 + index * 5.6, 0.06, -6],
      [1.2, 0.01, 0.1],
      0xe4cf9c,
    );

  for (const [index, x] of [-31, -23].entries()) {
    const id = `service-garage-${index}`;
    add(id, 'SERVICE', 'box', [x, 1.8, -14], [6.4, 3.6, 5.2], 0xc7c5b5, true);
    add(`${id}-roof`, 'SERVICE', 'box', [x, 3.72, -14], [6.6, 0.24, 5.4], 0x667d88);
    add(`${id}-door`, 'SERVICE', 'box', [x, 1.35, -11.385], [4.8, 2.5, 0.04], 0x34454d);
    for (let strip = 0; strip < 4; strip += 1)
      add(
        `${id}-door-rib-${strip}`,
        'SERVICE',
        'box',
        [x, 0.5 + strip * 0.5, -11.355],
        [4.7, 0.035, 0.025],
        0x82969d,
      );
    sign(`${id}-label`, 'SERVICE', `SERVICE 0${index + 1}`, x, 3.13, -11.35, 5.6, 0.65);
    cone(`${id}-cone`, 'SERVICE', x + 3.4, -10.5);
  }
  add('tool-store', 'SERVICE', 'box', [-14, 1.3, -15.5], [4, 2.6, 4], 0xb3986f, true);
  sign('tool-store-label', 'SERVICE', 'TOOLS / FUEL', -14, 2.1, -13.48, 3.8, 0.65);
  crate('service-crate', 'SERVICE', -16, -10);
  tires('service-tires-a', 'SERVICE', -36, -11);
  tires('service-tires-b', 'SERVICE', -36, -14);
  add(
    'fuel-drum',
    'SERVICE',
    'cylinder',
    [-11.5, 0.6, -11.5],
    [0.9, 1.2, 0.9],
    0xba7d54,
    true,
  );

  add(
    'race-control-building',
    'CONTROL',
    'box',
    [-23, 1.8, 14],
    [9, 3.6, 5],
    0xcac6b4,
    true,
  );
  add('race-control-roof', 'CONTROL', 'box', [-23, 3.72, 14], [9.3, 0.24, 5.3], 0x5f727a);
  add(
    'control-window-front',
    'CONTROL',
    'box',
    [-23, 2.4, 11.475],
    [7.8, 1.1, 0.05],
    0x567b8d,
  );
  add(
    'control-window-back',
    'CONTROL',
    'box',
    [-23, 2.4, 16.525],
    [7.8, 1.1, 0.05],
    0x567b8d,
  );
  sign(
    'control-label-front',
    'CONTROL',
    'RACE CONTROL',
    -23,
    3.13,
    11.44,
    8,
    0.6,
    Math.PI,
  );
  sign('control-label-back', 'CONTROL', 'RACE CONTROL', -23, 3.13, 16.56, 8, 0.6);
  add(
    'control-platform',
    'CONTROL',
    'box',
    [-23, 0.22, 9.8],
    [8, 0.44, 2],
    0xa6aaa5,
    true,
  );
  add('control-antenna', 'CONTROL', 'box', [-25, 5, 14], [0.07, 2.4, 0.07], 0x60717b);
  add('antenna-crossbar', 'CONTROL', 'box', [-25, 5.8, 14], [1.3, 0.07, 0.07], 0x60717b);
  add(
    'timing-tower-base',
    'CONTROL',
    'box',
    [-14, 0.65, 14],
    [2.6, 1.3, 2.6],
    0xc1bdaa,
    true,
  );
  add('timing-tower-shaft', 'CONTROL', 'box', [-14, 4.8, 14], [0.8, 8.3, 0.8], 0x657983);
  add(
    'timing-tower-board',
    'CONTROL',
    'box',
    [-14, 8.3, 14],
    [5, 2.8, 0.9],
    0x293c45,
    true,
  );
  for (const [side, yaw] of [
    [-1, Math.PI],
    [1, 0],
  ]) {
    sign(
      `timing-title-${side}`,
      'CONTROL',
      'LAP / TIME',
      -14,
      9,
      14 + side! * 0.48,
      4.6,
      0.6,
      yaw,
    );
    sign(
      `timing-numbers-${side}`,
      'CONTROL',
      '01   02   03',
      -14,
      8,
      14 + side! * 0.48,
      4.6,
      0.8,
      yaw,
    );
  }
  vehicle('maintenance-van', 'CONTROL', -32, 3, [2.4, 2.3, 5], 0xe4e3d6);
  vehicle('safety-pickup', 'CONTROL', -32, 12, [2.2, 1.85, 4.5], 0xdeba60);
  for (const x of [-18, -10]) {
    add(
      `control-flagpole-${x}`,
      'CONTROL',
      'box',
      [x, 2.8, 19.5],
      [0.1, 5.6, 0.1],
      0x647681,
    );
    add(
      `control-flag-${x}`,
      'CONTROL',
      'box',
      [x + 0.7, 5.1, 19.5],
      [1.3, 0.75, 0.03],
      0xdbab57,
    );
  }

  for (const [index, x] of [15, 24, 33].entries()) {
    const id = `team-tent-${index}`;
    const color = [0x558896, 0xd39352, 0xa96661][index]!;
    add(`${id}-roof`, 'PADDOCK', 'canopy', [x, 3.7, 13], [7.1, 1.4, 5.6], color);
    // Frame colliders match visible posts; the open space beneath the roof stays open.
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        add(
          `${id}-post-${sx}-${sz}`,
          'PADDOCK',
          'box',
          [x + sx * 3.1, 1.55, 13 + sz * 2.4],
          [0.18, 3.1, 0.18],
          0x61717b,
          true,
        );
    add(`${id}-fascia`, 'PADDOCK', 'box', [x, 3, 10.5], [6.8, 0.45, 0.1], color);
    sign(
      `${id}-name`,
      'PADDOCK',
      ['OVAL WORKS', 'FULL SEND', 'CLUB CREW'][index]!,
      x,
      3.03,
      10.44,
      6.3,
      0.45,
      Math.PI,
    );
    crate(`${id}-equipment`, 'PADDOCK', x, 14.6, 2.2);
    cone(`${id}-cone`, 'PADDOCK', x - 3.6, 7.3);
  }
  vehicle('team-trailer-a', 'PADDOCK', 19, 19, [2.2, 2, 3.4], 0xb7c4c5);
  vehicle('team-trailer-b', 'PADDOCK', 28, 19, [2.2, 2, 3.4], 0xc9bd9d);
  tires('paddock-tires-a', 'PADDOCK', 11.5, 18.7);
  tires('paddock-tires-b', 'PADDOCK', 36.5, 18.7);

  vehicle('recovery-tow-truck', 'RECOVERY', 28, -15, [2.7, 2.1, 6], 0xcdb36d);
  add(
    'tow-recovery-boom',
    'RECOVERY',
    'box',
    [28, 2.25, -17],
    [0.35, 0.3, 3.4],
    0x51636c,
  );
  add('marshal-booth', 'RECOVERY', 'box', [21, 1.25, -16.5], [3, 2.5, 3], 0xd4c9b1, true);
  sign('marshal-label', 'RECOVERY', 'RECOVERY', 21, 2, -14.98, 2.8, 0.6);
  crate('recovery-equipment', 'RECOVERY', 33, -17);
  add(
    'recovery-concrete-block',
    'RECOVERY',
    'box',
    [34, 0.45, -11],
    [2.5, 0.9, 1],
    0xbac1ba,
    true,
  );
  for (let index = 0; index < 3; index += 1)
    cone(`recovery-cone-${index}`, 'RECOVERY', 22 + index * 4, -10);
  return elements;
}

export const INFIELD_LAYOUT = createLayout();
