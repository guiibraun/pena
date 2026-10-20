// Bevel: lit, raised edges that follow the shape of the layer (text included). Effect.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @content */
uniform sampler2D u_content;
/** @sdf */
uniform sampler2D u_sdf;
/** @label Bevel width @default 8 @range 1, 60 */
uniform float u_width;
/** @label Depth @default 1.5 @range 0, 5 */
uniform float u_depth;
/** @label Light angle @default 135 @range -180, 180 */
uniform float u_light;
/** @label Shine @default 0.6 @range 0, 2 */
uniform float u_shine;
/** @label Shadow @default 0.5 @range 0, 1 */
uniform float u_shadow;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 c = texture2D(u_content, uv);
  vec4 s = texture2D(u_sdf, uv);
  float t = clamp(s.r / u_width, 0.0, 1.0);
  float slope = (1.0 - t) * (1.0 - t) * u_depth;
  vec3 n = normalize(vec3(-s.gb * slope, 1.0));
  float a = radians(u_light);
  vec3 l = normalize(vec3(cos(a), sin(a), 0.9));
  float diffuse = dot(n, l);
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 20.0);
  vec3 rgb = c.rgb * mix(1.0, clamp(0.35 + 0.75 * diffuse, 0.0, 1.4), u_shadow) + spec * u_shine * c.a * (1.0 - t);
  gl_FragColor = vec4(min(rgb, vec3(c.a)), c.a);
}
