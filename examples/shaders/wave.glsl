// Wave: bends the layer like a flag in the wind. Effect, animated.
precision highp float;
/** @resolution */
uniform vec2 u_resolution;
/** @time */
uniform float u_time;
/** @content */
uniform sampler2D u_content;
/** @label Amplitude @default 10 @range 0, 80 */
uniform float u_amplitude;
/** @label Waves @default 2 @range 0.25, 12 */
uniform float u_waves;
/** @label Speed @default 0.5 @range 0, 4 */
uniform float u_speed;
/** @label Direction @default 0 @range -180, 180 */
uniform float u_angle;

void main() {
  vec2 p = gl_FragCoord.xy;
  float a = radians(u_angle);
  vec2 along = vec2(cos(a), sin(a)), across = vec2(-along.y, along.x);
  float phase = dot(p / u_resolution, along) * u_waves + u_time * u_speed;
  vec2 offset = across * sin(phase * 6.2831853) * u_amplitude;
  gl_FragColor = texture2D(u_content, (p + offset) / u_resolution);
}
