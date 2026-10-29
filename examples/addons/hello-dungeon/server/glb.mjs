// A binary glTF (.glb) writer for one mesh of boxes: the cavern's walls,
// raised to their heights, one unit per square. Enough to show the whole
// path a 3D map addon's model takes (written to outputDir, stored with the
// map, handed to the board view on request); a real addon would export from
// Blender or a similar tool, which writes .glb directly.

const FACES = [
  // normal, then four corners as [x, y, z] offsets in the unit cube
  [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
  [[0, 0, -1], [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]],
  [[1, 0, 0], [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]]],
  [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
  [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
];

// boxes: [{ x, z, height }] in squares; y is up.
export function encodeBoxesGlb(boxes) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (const box of boxes) {
    for (const [normal, corners] of FACES) {
      const base = positions.length / 3;
      for (const [cx, cy, cz] of corners) {
        positions.push(box.x + cx, cy * box.height, box.z + cz);
        normals.push(...normal);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const positionBytes = Buffer.from(new Float32Array(positions).buffer);
  const normalBytes = Buffer.from(new Float32Array(normals).buffer);
  const indexBytes = Buffer.from(new Uint32Array(indices).buffer);
  const bin = Buffer.concat([positionBytes, normalBytes, indexBytes]);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[index + axis]);
      max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  const count = positions.length / 3;
  const json = {
    asset: { version: "2.0", generator: "hello-dungeon example" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "walls" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.42, 0.44, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: normalBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length + normalBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min: count ? min : [0, 0, 0], max: count ? max : [0, 0, 0] },
      { bufferView: 1, componentType: 5126, count, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
  };
  const pad = (buffer, fill) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHeader = (length, type) => {
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32LE(length, 0);
    buffer.write(type, 4, "ascii");
    return buffer;
  };
  return Buffer.concat([header, chunkHeader(jsonChunk.length, "JSON"), jsonChunk, chunkHeader(binChunk.length, "BIN\0"), binChunk]);
}
