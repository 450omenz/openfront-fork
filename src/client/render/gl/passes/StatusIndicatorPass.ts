/**
 * StatusIndicatorPass — per-unit status indicators (fork).
 *
 * Draws one instanced quad per (unit, active indicator), for every UnitStatus
 * bit that has an entry in the registry (../../UnitStatusIndicators.ts).
 * Shapes ("!" badge, pulsing ring) are procedural in the fragment shader, so
 * adding an indicator never needs atlas art or renderer changes.
 *
 * Data flow:
 *   UnitState.statusFlags → registry lookup → instance VBO (x, y, index,
 *   scale) → per-index uniforms (color, size, offsetY, shape, pulseHz)
 *
 * Indicators on mobile units grow and shrink with the unit sprite (see
 * ../UnitScale.ts); structure indicators keep their size.
 */
import type { UnitState } from "../../types";
import type { RenderSettings } from "../RenderSettings";
import { screenScale, typeScale } from "../UnitScale";
import {
  activeIndicatorIndices,
  MAX_STATUS_INDICATORS,
  SHAPE_CODE,
  STATUS_INDICATORS,
} from "../../UnitStatusIndicators";
import statusFragSrc from "../shaders/status-indicator/status.frag.glsl?raw";
import statusVertSrc from "../shaders/status-indicator/status.vert.glsl?raw";
import { createProgram } from "../utils/GlUtils";

const FLOATS_PER_INSTANCE = 4; // x, y, registry index, unit scale (0 = structure)
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
const INITIAL_CAPACITY = 256;

export class StatusIndicatorPass {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly instanceBuf: WebGLBuffer;
  private readonly uCamera: WebGLUniformLocation;
  private readonly uTime: WebGLUniformLocation;
  private readonly uScreenScale: WebGLUniformLocation;
  private data = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_INSTANCE);
  private capacity = INITIAL_CAPACITY;
  private count = 0;
  private readonly mapW: number;

  constructor(
    gl: WebGL2RenderingContext,
    mapWidth: number,
    private readonly settings: RenderSettings,
  ) {
    this.gl = gl;
    this.mapW = mapWidth;
    this.program = createProgram(
      gl,
      statusVertSrc,
      statusFragSrc,
      "StatusIndicatorPass",
    );
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uTime = gl.getUniformLocation(this.program, "uTime")!;
    this.uScreenScale = gl.getUniformLocation(this.program, "uScreenScale")!;

    // Registry → uniform arrays, uploaded once.
    const colors = new Float32Array(MAX_STATUS_INDICATORS * 3);
    const params = new Float32Array(MAX_STATUS_INDICATORS * 4);
    STATUS_INDICATORS.forEach((ind, i) => {
      colors.set(ind.color, i * 3);
      params.set(
        [ind.size, ind.offsetY, SHAPE_CODE[ind.shape], ind.pulseHz],
        i * 4,
      );
    });
    gl.useProgram(this.program);
    gl.uniform3fv(gl.getUniformLocation(this.program, "uColor"), colors);
    gl.uniform4fv(gl.getUniformLocation(this.program, "uParams"), params);
    gl.useProgram(null);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.capacity * BYTES_PER_INSTANCE,
      gl.DYNAMIC_DRAW,
    );
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
  }

  /** Rebuild instances from the current units. */
  update(
    mobileUnits: Map<number, UnitState>,
    structures: Map<number, UnitState>,
  ): void {
    this.count = 0;
    const us = this.settings.unit;
    for (const unit of mobileUnits.values()) {
      if (!unit.isActive || unit.statusFlags === 0) continue;
      const scale = typeScale(unit.unitType, us);
      for (const idx of activeIndicatorIndices(unit.statusFlags)) {
        this.push(unit.pos, idx, scale);
      }
    }
    for (const unit of structures.values()) {
      if (!unit.isActive || unit.statusFlags === 0) continue;
      for (const idx of activeIndicatorIndices(unit.statusFlags)) {
        this.push(unit.pos, idx, 0);
      }
    }
  }

  private push(pos: number, index: number, scale: number): void {
    if (this.count >= this.capacity) {
      this.capacity *= 2;
      const grown = new Float32Array(this.capacity * FLOATS_PER_INSTANCE);
      grown.set(this.data);
      this.data = grown;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.capacity * BYTES_PER_INSTANCE,
        gl.DYNAMIC_DRAW,
      );
    }
    const off = this.count * FLOATS_PER_INSTANCE;
    const x = pos % this.mapW;
    this.data[off] = x;
    this.data[off + 1] = (pos - x) / this.mapW;
    this.data[off + 2] = index;
    this.data[off + 3] = scale;
    this.count++;
  }

  draw(cameraMat: Float32Array, zoom: number): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMat);
    gl.uniform1f(this.uScreenScale, screenScale(zoom, this.settings.unit));
    gl.uniform1f(this.uTime, performance.now() / 1000);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.data.subarray(0, this.count * FLOATS_PER_INSTANCE),
    );
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.instanceBuf);
    this.gl.deleteVertexArray(this.vao);
  }
}
