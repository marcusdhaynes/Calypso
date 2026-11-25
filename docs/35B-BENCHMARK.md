# Low-memory 35B benchmark

Reference: [RTX 4070 8GB / 16GB DDR5 community experiment](https://github.com/hmishra2250/qwen-3.6-35b-consumer-gpu). Its higher-quality IQ4_XS configuration reports 10–15 tokens/s on practical coding tasks and 9/10 on a ten-task SWE challenge with retries and thinking disabled. Its smaller IQ3_XXS configuration reports 10–17 tokens/s on coding and 43.3 tokens/s in a separate synthetic workload; coding score 5/10. The reference uses an i7-14700HX and DDR5, not the i7-13620H and 3200 MT/s memory of the target laptop. Results are not transferable without measurement.

Calypso's ordinary Ollama selector still has conservative memory limits. This separate llama.cpp benchmark tests the published approach instead of pretending a stock Ollama pull has the same memory footprint.

## Windows

1. Install or extract a current CUDA-enabled llama.cpp Windows x64 build from https://github.com/ggml-org/llama.cpp/releases . If needed extract the matching CUDA runtime DLL bundle into the same directory.
2. Exit Ollama and close other high-memory apps. Keep the laptop on AC power. Do not run Calypso jobs during the benchmark.
3. In the Calypso checkout, run PowerShell:

```powershell
$env:CALYPSO_LLAMA_SERVER = 'C:\path\to\llama-server.exe'
node scripts/benchmark-35b.mjs
```

The script downloads the exact Unsloth GGUF files through llama.cpp, tries IQ4_XS and IQ3_XXS sequentially, and saves a JSON report and runtime logs in the home directory's calypso-benchmark folder. Budget around 35 GB of download/storage for both plus reserve. No keys, model deletion, paging changes, or cloud inference. The default Windows-safe trial uses memory mapping, an 8K context, six CPU threads, 30/25 CPU expert layers and quantized KV cache. These are adapted settings, not a claim to reproduce the reference's 128K context or its Linux no-mmap configuration.

A candidate must produce the correct tool call and arithmetic answer, usable text on three sustained requests, median generation speed of at least 5 tokens/s, and sampled memory headroom. The report distinguishes decode timing from end-to-end rates. These are smoke checks, not SWE-bench or full OpenClaw verification. Prefer IQ4_XS when both pass. Larger SSD-streamed models need their own separate benchmarks and are not assumed to be viable.

The unified engine now automatically runs these profiles on eligible Windows NVIDIA laptops. It installs a checksum-verified llama.cpp CUDA 12.4 build, downloads and checks SHA-256 for both exact GGUF weight files, tests 16K then 8K context if needed, persists results, launches the winner on a private authenticated loopback endpoint, and registers a dedicated OpenClaw model provider. The manual benchmark remains useful for diagnostics. Actual end-to-end model performance and gateway compatibility must still be verified on the user's computer.

## On-device verification

After the managed 35B runtime starts, Calypso automatically checks a fresh exact response through both streaming and non-streaming inference and attempts a real OpenClaw read/write diagnostic using a random test fixture. It requires the actual agent metadata to identify the dedicated local provider and model, successful read/write tool receipts, and an independently verified file. Settings shows separate pass/fail/blocked statuses; **Verify Local AI & OpenClaw** repeats the check. The full local report is saved under the engine data directory at `local-inference/verification/latest.json`. A successful CI test is not a substitute for this report.
