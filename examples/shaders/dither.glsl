// Dither: two-color ordered (Bayer) dithering in chunky pixels. Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @label Pixel size @default 3 @range 1, 16 */
uniform float u_size;
/** @label Dark @color @default #0B0C10 */
uniform vec3 u_dark;
/** @label Light @color @default #E8F0C8 */
uniform vec3 u_light;
/** @label Threshold @default 0 @range -0.5, 0.5 */
uniform float u_bias;

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

void main() {
  vec2 cell = floor(gl_FragCoord.xy / u_size);
  vec4 c = texture2D(u_content, (cell + 0.5) * u_size / u_resolution);
  vec3 rgb = c.rgb / max(c.a, 0.0001);
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float on = step(bayer8(cell) + u_bias, l);
  float a = texture2D(u_content, gl_FragCoord.xy / u_resolution).a;
  gl_FragColor = vec4(mix(u_dark, u_light, on) * a, a);
}
