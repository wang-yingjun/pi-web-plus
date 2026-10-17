import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const PYTHON_PATH = "/Users/yingjunwang/tools/whisper-venv/bin/python";
const WHISPER_SCRIPT = `
import sys, mlx_whisper, os
os.environ['HF_HUB_OFFLINE'] = '1'
result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo="mlx-community/whisper-large-v3-turbo", language=sys.argv[2])
print(result["text"], end='')
`;

export async function GET() {
  return NextResponse.json({ available: true });
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const audio = form.get("audio") as Blob | null;
    const lang = (form.get("lang") as string) || "zh";
    
    if (!audio) {
      return NextResponse.json({ error: "no audio" }, { status: 400 });
    }

    const buffer = Buffer.from(await audio.arrayBuffer());
    const tempPath = join(tmpdir(), `asr-${Date.now()}.webm`);
    await writeFile(tempPath, buffer);

    const python = spawn(PYTHON_PATH, ["-c", WHISPER_SCRIPT, tempPath, lang.slice(0, 2)]);
    let text = "";
    let stderr = "";

    for await (const chunk of python.stdout) {
      text += chunk.toString();
    }
    for await (const chunk of python.stderr) {
      stderr += chunk.toString();
    }

    const code = await new Promise<number>((resolve) => {
      python.on("exit", (c) => resolve(c ?? 1));
    });

    await unlink(tempPath).catch(() => {});

    if (code !== 0) {
      console.error(`[voice/asr] whisper failed: ${stderr}`);
      return NextResponse.json({ error: "transcription failed" }, { status: 500 });
    }

    // 中文标点转全角
    const normalized = text.replace(/,/g, "，").replace(/\./g, "。").replace(/\?/g, "？").replace(/!/g, "！");
    
    return NextResponse.json({ text: normalized.trim() });
  } catch (err) {
    console.error("[voice/asr]", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
