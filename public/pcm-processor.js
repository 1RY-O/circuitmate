// AudioWorklet: capture mic float32, linear-resample to 24kHz, post PCM16.
// Per AssemblyAI docs: let AudioContext run at device rate, resample in worklet
// so Firefox keeps echo cancellation and Safari (ignores sampleRate hint) stays correct.
class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate = 48000, targetSampleRate = 24000 } = options.processorOptions || {};
    this.ratio = inputSampleRate / targetSampleRate;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      const outLen = Math.max(1, Math.floor(input.length / this.ratio));
      const pcm16 = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const s = input[Math.floor(i * this.ratio)] ?? 0;
        pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}
registerProcessor("pcm-processor", PCMProcessor);
