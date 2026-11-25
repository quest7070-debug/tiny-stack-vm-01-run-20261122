// Tiny stack VM for make.fun's tiny stack ISA v1 (see kit ISA.md).
// One run answers every instance: for each /input/<id>/ it reads
// program.bin + input.bin and writes /output/<id>/stdout.bin + exit.txt.
// Node 22 runs this file as `node /bot/main.ts`; plain JS in a .ts file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Opcode table: [byte, immediate bytes, pops, pushes] for every valid opcode.
const OPS = [
  [0x00, 0, 0, 0], [0x01, 1, 0, 1], [0x02, 4, 0, 1], [0x03, 0, 1, 0],
  [0x04, 0, 1, 2], [0x05, 0, 2, 2], [0x06, 0, 2, 3], [0x07, 0, 3, 3],
  [0x10, 0, 2, 1], [0x11, 0, 2, 1], [0x12, 0, 2, 1], [0x13, 0, 2, 1],
  [0x14, 0, 2, 1], [0x15, 0, 2, 1], [0x16, 0, 2, 1], [0x17, 0, 1, 1],
  [0x18, 0, 2, 1], [0x19, 0, 2, 1], [0x1a, 0, 2, 1], [0x1b, 0, 1, 1],
  [0x1c, 0, 2, 1], [0x1d, 0, 2, 1], [0x1e, 0, 2, 1], [0x20, 0, 2, 1],
  [0x21, 0, 2, 1], [0x22, 0, 2, 1], [0x30, 2, 0, 0], [0x31, 2, 1, 0],
  [0x32, 2, 1, 0], [0x33, 2, 0, 0], [0x34, 0, 0, 0], [0x40, 0, 1, 1],
  [0x41, 0, 2, 0], [0x50, 0, 1, 0], [0x51, 0, 1, 0], [0x52, 0, 0, 1],
  [0x53, 0, 1, 0],
];
const IMM = new Uint8Array(256);
const POPS = new Uint8Array(256);
const PUSH = new Uint8Array(256);
const VALID = new Uint8Array(256);
for (const [o, im, po, pu] of OPS) {
  IMM[o] = im; POPS[o] = po; PUSH[o] = pu; VALID[o] = 1;
}

// Run one program; returns [stdout bytes, exit code]. Traps end the run
// with the trap's code as the exit code, keeping earlier output.
function run(p, inp) {
  const n = p.length;
  const D = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack
  const M = new Int32Array(256); // memory
  const out = []; // output bytes
  let sp = 0, cp = 0, ip = 0, pc = 0, steps = 0;
  const done = (exit) => [Buffer.from(out), exit];
  for (;;) {
    if (steps === 1000000) return done(10); // step limit
    if (pc < 0 || pc >= n) return done(9); // pc outside program
    const op = p[pc];
    if (!VALID[op]) return done(5); // unknown opcode
    const im = IMM[op];
    if (pc + im >= n) return done(9); // immediate cut off
    steps++;
    const nx = pc + 1 + im;
    const po = POPS[op], pu = PUSH[op];
    if (sp < po) return done(2); // stack underflow
    if (sp - po + pu > 256) return done(3); // stack overflow
    pc = nx;
    switch (op) {
      case 0x00: return done(0); // HALT
      case 0x01: D[sp++] = (p[nx - 1] << 24) >> 24; break; // PUSH8 sign-extended
      case 0x02: D[sp++] = p[nx - 4] | (p[nx - 3] << 8) | (p[nx - 2] << 16) | (p[nx - 1] << 24); break; // PUSH32
      case 0x03: sp--; break; // POP
      case 0x04: D[sp] = D[sp - 1]; sp++; break; // DUP
      case 0x05: { const t = D[sp - 1]; D[sp - 1] = D[sp - 2]; D[sp - 2] = t; break; } // SWAP
      case 0x06: D[sp] = D[sp - 2]; sp++; break; // OVER
      case 0x07: { const a = D[sp - 3]; D[sp - 3] = D[sp - 2]; D[sp - 2] = D[sp - 1]; D[sp - 1] = a; break; } // ROT
      case 0x17: D[sp - 1] = -D[sp - 1] | 0; break; // NEG
      case 0x1b: D[sp - 1] = ~D[sp - 1]; break; // NOT
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
      case 0x18: case 0x19: case 0x1a: case 0x1c: case 0x1d: case 0x1e:
      case 0x20: case 0x21: case 0x22: {
        const b = D[sp - 1], a = D[sp - 2];
        let r;
        if (op === 0x10) r = (a + b) | 0;
        else if (op === 0x11) r = (a - b) | 0;
        else if (op === 0x12) r = Math.imul(a, b);
        else if (op === 0x13) {
          if (b === 0) return done(4);
          r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
        } else if (op === 0x14) {
          if (b === 0) return done(4);
          r = b === -1 ? 0 : (a % b) | 0;
        } else if (op === 0x15) {
          if (b === 0) return done(4);
          r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
        } else if (op === 0x16) {
          if (b === 0) return done(4);
          r = ((a >>> 0) % (b >>> 0)) | 0;
        } else if (op === 0x18) r = a & b;
        else if (op === 0x19) r = a | b;
        else if (op === 0x1a) r = a ^ b;
        else if (op === 0x1c) r = a << (b & 31);
        else if (op === 0x1d) r = a >> (b & 31);
        else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
        else if (op === 0x20) r = a === b ? 1 : 0;
        else if (op === 0x21) r = a < b ? 1 : 0;
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0;
        sp -= 2; D[sp++] = r;
        break;
      }
      case 0x30: case 0x31: case 0x32: {
        const rel = ((p[nx - 2] | (p[nx - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = nx + rel;
        break;
      }
      case 0x33: // CALL
        if (cp === 64) return done(7);
        C[cp++] = nx;
        pc = p[nx - 2] | (p[nx - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return done(8);
        pc = C[--cp];
        break;
      case 0x40: { // LOAD
        const addr = D[sp - 1];
        if (addr < 0 || addr > 255) return done(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: { // STORE
        const addr = D[sp - 1], v = D[sp - 2];
        if (addr < 0 || addr > 255) return done(6);
        sp -= 2; M[addr] = v;
        break;
      }
      case 0x50: { // PRINT
        const s = String(D[sp - 1]);
        if (out.length + s.length > 65536) return done(11);
        sp--;
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
        break;
      }
      case 0x51: // PUTC
        if (out.length + 1 > 65536) return done(11);
        out.push(D[--sp] & 255);
        break;
      case 0x52: D[sp++] = ip < inp.length ? inp[ip++] : -1; break; // IN
      case 0x53: return done(D[--sp] & 255); // EXIT
    }
  }
}

for (const id of readdirSync(I).sort()) {
  const prog = readFileSync(join(I, id, 'program.bin'));
  const inp = readFileSync(join(I, id, 'input.bin'));
  const [stdout, exit] = run(prog, inp);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), stdout);
  writeFileSync(join(O, id, 'exit.txt'), exit + '\n');
}
