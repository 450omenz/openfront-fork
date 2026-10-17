/**
 * TileOverlayPass (fork) — colors every tile from a palette index, for the
 * population density and climate view modes.
 *
 * The CPU fills one byte per tile (ViewOverlayData) and uploads it into an
 * R8UI texture; the fragment shader looks the byte up in a 256×1 RGBA
 * palette. Index 0 is transparent. Drawn between territory and borders so
 * borders, structures and names stay readable on top.
 */

import type { RenderSettings } from "../RenderSettings";
import {
  createMapQuad,
  createProgram,
  createTexture2D,
} from "../utils/GlUtils";

import overlayVertSrc from "../shaders/map-overlay/overlay.vert.glsl?raw";
import fragSrc from "../shaders/tile-overlay/tile-overlay.frag.glsl?raw";

export class TileOverlayPass {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private indexTex: WebGLTexture;
  private paletteTex: WebGLTexture;
  private uCamera: WebGLUniformLocation;
  private uOpacity: WebGLUniformLocation;
  private active = false;
  private opacity = 0.75;

  constructor(
    gl: WebGL2RenderingContext,
    private mapW: number,
    private mapH: number,
    _settings: RenderSettings,
  ) {
    this.gl = gl;
    this.program = createProgram(gl, overlayVertSrc, fragSrc, "TileOverlay");
    this.uCamera = gl.getUniformLocation(this.program, "uCamera")!;
    this.uOpacity = gl.getUniformLocation(this.program, "uOpacity")!;
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uIndex"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 1);

    this.indexTex = createTexture2D(gl, {
      width: mapW,
      height: mapH,
      internalFormat: gl.R8UI,
      format: gl.RED_INTEGER,
      type: gl.UNSIGNED_BYTE,
      data: null,
    });
    this.paletteTex = createTexture2D(gl, {
      width: 256,
      height: 1,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: new Uint8Array(256 * 4),
    });
    this.vao = createMapQuad(gl, mapW, mapH);
  }

  /** Show `indices` (one byte per tile) colored by `palette` (256 RGBA). */
  set(indices: Uint8Array, palette: Uint8Array, opacity: number): void {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.mapW,
      this.mapH,
      gl.RED_INTEGER,
      gl.UNSIGNED_BYTE,
      indices,
    );
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      256,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      palette,
    );
    this.opacity = opacity;
    this.active = true;
  }

  clear(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  draw(cameraMatrix: Float32Array): void {
    if (!this.active) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.uniformMatrix3fv(this.uCamera, false, cameraMatrix);
    gl.uniform1f(this.uOpacity, this.opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.indexTex);
    gl.deleteTexture(this.paletteTex);
  }
}
