#!/usr/bin/env python3
"""
Export Beat This! pretrained model to ONNX format for use with onnxruntime-node.

Requirements:
    pip install beat_this torch torchaudio onnx

Usage:
    python scripts/export-beat-this.py
    python scripts/export-beat-this.py --checkpoint final0 --output ~/Library/Application\\ Support/crate/models/beat_this.onnx

The output ONNX file should be placed at:
    ~/Library/Application Support/crate/models/beat_this.onnx

The model expects:
    Input  'input':    float32 [1, num_frames, 128]  (log-mel spectrogram)
    Output 'beat':     float32 [1, num_frames]        (beat activation 0-1)
    Output 'downbeat': float32 [1, num_frames]        (downbeat activation 0-1)

Mel spectrogram parameters (must match src/main/integrations/beat-analysis/mel-spectrogram.ts):
    sample_rate = 22050
    n_fft       = 2048
    hop_length  = 441
    n_mels      = 128
    f_min       = 30.0
    f_max       = 11000.0
    norm        = 'slaney'
    mel_scale   = 'htk'
    power       = 2.0  (power spectrogram → log dB)
"""

import argparse
import os
import pathlib

import torch

CHECKPOINT_CHOICES = ['final0', 'final1', 'final2', 'final3', 'final4',
                      'finetuned0', 'finetuned1', 'finetuned2', 'finetuned3', 'finetuned4']

DEFAULT_OUT = pathlib.Path.home() / 'Library' / 'Application Support' / 'crate' / 'models' / 'beat_this.onnx'


def export(checkpoint: str, output: pathlib.Path) -> None:
    from beat_this.model.beat_tracker import BeatThis  # type: ignore
    from beat_this.inference import load_model         # type: ignore

    print(f'Loading checkpoint: {checkpoint}')
    model = load_model(checkpoint, device='cpu')
    model.eval()

    # Typical 6-minute track at 20ms/frame → ~18000 frames.
    # Use a representative length for tracing; dynamic axes handle real lengths.
    dummy = torch.randn(1, 1500, 128)

    output.parent.mkdir(parents=True, exist_ok=True)

    print(f'Exporting to: {output}')
    torch.onnx.export(
        model,
        dummy,
        str(output),
        input_names=['input'],
        output_names=['beat', 'downbeat'],
        dynamic_axes={
            'input':     {1: 'num_frames'},
            'beat':      {1: 'num_frames'},
            'downbeat':  {1: 'num_frames'},
        },
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,   # use legacy TorchScript-based exporter — more compatible
    )

    # Verify the export
    import onnx  # type: ignore
    model_proto = onnx.load(str(output))
    onnx.checker.check_model(model_proto)
    size_mb = output.stat().st_size / 1_048_576
    print(f'OK — {size_mb:.1f} MB — inputs: {[i.name for i in model_proto.graph.input]} '
          f'outputs: {[o.name for o in model_proto.graph.output]}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Export Beat This! to ONNX')
    parser.add_argument('--checkpoint', default='final0', choices=CHECKPOINT_CHOICES)
    parser.add_argument('--output', type=pathlib.Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    export(args.checkpoint, args.output)
