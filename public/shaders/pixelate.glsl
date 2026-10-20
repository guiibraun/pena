// Pixelate: big square (or round) pixels. Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @label Pixel size @default 12 @range 2, 80 */
uniform float u_size;
/** @label Round pixels @default 0 @range 0, 1 */
uniform float u_round;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 cell = (floor(p / u_size) + 0.5) * u_size;
  vec4 color = texture2D(u_content, cell / u_resolution);
  float r = length((p - cell) / (u_size * 0.5));
  float disc = 1.0 - smoothstep(1.0 - 2.0 / u_size, 1.0, r);
  gl_FragColor = color * mix(1.0, disc, u_round);
}
