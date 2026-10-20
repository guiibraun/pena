// Chromatic aberration: splits the red and blue channels apart. Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @label Amount @default 6 @range 0, 40 */
uniform float u_amount;
/** @label Angle @default 0 @range -180, 180 */
uniform float u_angle;
/** @label From center @default 0 @range 0, 1 */
uniform float u_radial;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float a = radians(u_angle);
  vec2 dir = mix(vec2(cos(a), sin(a)), (uv - 0.5) * 2.0, u_radial);
  vec2 o = dir * u_amount / u_resolution;
  vec4 r = texture2D(u_content, uv + o), g = texture2D(u_content, uv), b = texture2D(u_content, uv - o);
  gl_FragColor = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}
