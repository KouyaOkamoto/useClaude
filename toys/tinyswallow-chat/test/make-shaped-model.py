# 本物のモデルと「同じ形」で、重みだけランダムで小さいモデルを作る（不具合の切り分け用）。
#
#   python3 make-shaped-model.py <本物の config.json・tokenizer*.json・generation_config.json があるディレクトリ> <出力先>
#
# 本物の config（Qwen2・28 層・KV ヘッド 2・ヘッドの次元 128・語彙 151936）・トークナイザ・チャットテンプレートをそのまま使い、
# ONNX は本物と同じ入出力名・同じ形・外部データ形式（model_*.onnx ＋ model_*.onnx_data）にする:
#   model_q4.onnx     … KV キャッシュ・logits が float32
#   model_q4f16.onnx  … KV キャッシュ・logits が float16（config の kv_cache_dtype と同じ）
# 重み（埋め込み・出力）は小さく、ランダム。終わりの印は出にくくしてある。
import json, os, shutil, sys
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

src, out = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(out, 'onnx'), exist_ok=True)
for f in ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json']:
    shutil.copy(os.path.join(src, f), os.path.join(out, f))
cfg = json.load(open(os.path.join(src, 'config.json')))
V, L, KV = cfg['vocab_size'], cfg['num_hidden_layers'], cfg['num_key_value_heads']
D = cfg.get('head_dim') or cfg['hidden_size'] // cfg['num_attention_heads']
eos = cfg['eos_token_id']
gen = json.load(open(os.path.join(src, 'generation_config.json')))
stops = gen['eos_token_id'] if isinstance(gen['eos_token_id'], list) else [gen['eos_token_id']]
H = 8
rng = np.random.default_rng(0)


def build(name, kv_type):
    np_kv = np.float16 if kv_type == TensorProto.FLOAT16 else np.float32
    bias = np.zeros(V, dtype=np.float32)
    bias[stops] = -1e4
    inits = [
        numpy_helper.from_array(rng.normal(size=(V, H)).astype(np.float32), 'emb'),
        numpy_helper.from_array(rng.normal(size=(H, V)).astype(np.float32), 'W'),
        numpy_helper.from_array(bias, 'B'),
        numpy_helper.from_array(rng.normal(size=(H, KV * D)).astype(np.float32), 'P'),
        numpy_helper.from_array(np.array([0, 0, KV, D], dtype=np.int64), 'shape4'),
    ]
    nodes = [
        helper.make_node('Gather', ['emb', 'input_ids'], ['h']),
        helper.make_node('MatMul', ['h', 'W'], ['hw']),
        helper.make_node('Add', ['hw', 'B'], ['logits32']),
        helper.make_node('MatMul', ['h', 'P'], ['hp']),
        helper.make_node('Reshape', ['hp', 'shape4'], ['h4']),
        helper.make_node('Transpose', ['h4'], ['kv32'], perm=[0, 2, 1, 3]),
        helper.make_node('Cast', ['kv32'], ['kv'], to=kv_type),
        helper.make_node('Cast', ['logits32'], ['logits'], to=kv_type),
        helper.make_node('Identity', ['attention_mask'], ['am_unused']),
        helper.make_node('Identity', ['position_ids'], ['pos_unused']),
    ]
    inputs = [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['batch_size', 'sequence_length']),
              helper.make_tensor_value_info('attention_mask', TensorProto.INT64, ['batch_size', 'total_sequence_length']),
              helper.make_tensor_value_info('position_ids', TensorProto.INT64, ['batch_size', 'sequence_length'])]
    outputs = [helper.make_tensor_value_info('logits', kv_type, ['batch_size', 'sequence_length', V])]
    for i in range(L):
        for kind in ('key', 'value'):
            inputs.append(helper.make_tensor_value_info(f'past_key_values.{i}.{kind}', kv_type, ['batch_size', KV, 'past_sequence_length', D]))
            outputs.append(helper.make_tensor_value_info(f'present.{i}.{kind}', kv_type, ['batch_size', KV, 'total_sequence_length', D]))
            nodes.append(helper.make_node('Concat', [f'past_key_values.{i}.{kind}', 'kv'], [f'present.{i}.{kind}'], axis=2))
    m = helper.make_model(helper.make_graph(nodes, 'shaped_qwen2', inputs, outputs, initializer=inits),
                          opset_imports=[helper.make_opsetid('', 17)], producer_name='tinyswallow-chat-test')
    m.ir_version = 8
    onnx.checker.check_model(m)
    # 本物と同じく、重みは外部データ（<name>_data）に置く
    onnx.save(m, os.path.join(out, 'onnx', name), save_as_external_data=True, all_tensors_to_one_file=True,
              location=name + '_data', size_threshold=1024)


build('model_q4.onnx', TensorProto.FLOAT)
build('model_q4f16.onnx', TensorProto.FLOAT16)
print('V', V, 'L', L, 'KV', KV, 'D', D, sorted(os.listdir(os.path.join(out, 'onnx'))))
