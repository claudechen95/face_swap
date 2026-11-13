const slider = document.querySelector('.comparison-range');
const comparison = document.querySelector('.comparison');

if (slider && comparison) {
  const setPosition = (value) => {
    slider.value = value;
    comparison.style.setProperty('--position', `${value}%`);
  };

  slider.addEventListener('input', () => setPosition(slider.value));

  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const restValue = Number(slider.value);
    const keyframes = [
      { time: 0, value: restValue },
      { time: 700, value: 22 },
      { time: 1500, value: 82 },
      { time: 2200, value: restValue },
    ];
    const duration = keyframes[keyframes.length - 1].time;
    const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2);

    let start = null;
    let frame = requestAnimationFrame(function loop(now) {
      start = start ?? now;
      const elapsed = (now - start) % duration;
      const i = keyframes.findIndex((k, idx) => elapsed < keyframes[idx + 1]?.time);
      const from = keyframes[i];
      const to = keyframes[i + 1];
      const progress = (elapsed - from.time) / (to.time - from.time);
      setPosition(from.value + (to.value - from.value) * ease(progress));
      frame = requestAnimationFrame(loop);
    });

    slider.addEventListener('pointerdown', () => cancelAnimationFrame(frame), { once: true });
  }
}
