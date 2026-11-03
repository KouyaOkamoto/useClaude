# テスト用の小さなモデルを作る（重みはランダム。返答は意味のない文字列になる）。
# 本物の TinySwallow-1.5B-Instruct-ONNX と同じ形（Qwen2 の config・ChatML のチャットテンプレート・
# input_ids / attention_mask / position_ids / past_key_values.N.key|value → logits / present.N.key|value）にして、
# Transformers.js の読み込み・ストリーミング・停止・会話の流れを、モデルをダウンロードせずに確かめる。
#
#   python3 make-tiny-model.py <出力先のディレクトリ>     （onnx・tokenizers・numpy が必要）
import json, os, sys
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper
from tokenizers import Tokenizer, models, trainers, pre_tokenizers, decoders

out = sys.argv[1]
os.makedirs(os.path.join(out, 'onnx'), exist_ok=True)

SPECIAL = ['<|endoftext|>', '<|im_start|>', '<|im_end|>']
text = ['こんにちは。日本の四季の魅力を教えてください。春は桜、夏は海、秋は紅葉、冬は雪です。',
        'カレーの作り方: 野菜を切って、炒めて、煮込んで、ルーを入れます。',
        'Hello, thank you. ありがとう。谢谢。감사합니다。', 'system user assistant']
tok = Tokenizer(models.BPE())
tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
tok.decoder = decoders.ByteLevel()
tok.train_from_iterator(text * 20, trainers.BpeTrainer(vocab_size=600, special_tokens=SPECIAL, initial_alphabet=pre_tokenizers.ByteLevel.alphabet()))
tok.save(os.path.join(out, 'tokenizer.json'))
V = tok.get_vocab_size()
eos = tok.token_to_id('<|im_end|>')
pad = tok.token_to_id('<|endoftext|>')

chat_template = ("{% for message in messages %}{{ '<|im_start|>' + message['role'] + '\\n' + message['content'] + '<|im_end|>' + '\\n' }}{% endfor %}"
                 "{% if add_generation_prompt %}{{ '<|im_start|>assistant\\n' }}{% endif %}")
json.dump({'tokenizer_class': 'Qwen2Tokenizer', 'chat_template': chat_template, 'eos_token': '<|im_end|>', 'pad_token': '<|endoftext|>',
           'bos_token': None, 'model_max_length': 32768, 'clean_up_tokenization_spaces': False,
           'added_tokens_decoder': {str(tok.token_to_id(t)): {'content': t, 'special': True, 'lstrip': False, 'rstrip': False, 'normalized': False, 'single_word': False} for t in SPECIAL}},
          open(os.path.join(out, 'tokenizer_config.json'), 'w'), ensure_ascii=False)

L, H, KV, D = 2, 8, 2, 4   # 層・隠れ次元・KV ヘッド・ヘッドの次元
json.dump({'architectures': ['Qwen2ForCausalLM'], 'model_type': 'qwen2', 'vocab_size': V, 'hidden_size': H, 'num_hidden_layers': L,
           'num_attention_heads': KV, 'num_key_value_heads': KV, 'head_dim': D, 'max_position_embeddings': 32768,
           'eos_token_id': eos, 'bos_token_id': pad, 'pad_token_id': pad, 'torch_dtype': 'float32',
           'transformers.js_config': {'kv_cache_dtype': {'q4f16': 'float16', 'fp16': 'float16'}}},
          open(os.path.join(out, 'config.json'), 'w'))
json.dump({'eos_token_id': [eos, pad], 'pad_token_id': pad, 'bos_token_id': pad}, open(os.path.join(out, 'generation_config.json'), 'w'))

rng = np.random.default_rng(0)
emb = numpy_helper.from_array(rng.normal(size=(V, H)).astype(np.float32), 'emb')
W = numpy_helper.from_array(rng.normal(size=(H, V)).astype(np.float32), 'W')
# 終わりの印（<|im_end|>・<|endoftext|>）は出ないようにする（最大トークン数まで続く。停止のテストに使う）
bias = np.zeros(V, dtype=np.float32)
bias[[eos, pad]] = -1e4
B = numpy_helper.from_array(bias, 'B')
shape4 = numpy_helper.from_array(np.array([0, 0, KV, D], dtype=np.int64), 'shape4')
nodes = [helper.make_node('Gather', ['emb', 'input_ids'], ['h']),
         helper.make_node('MatMul', ['h', 'W'], ['hw']),
         helper.make_node('Add', ['hw', 'B'], ['logits']),
         helper.make_node('Reshape', ['h', 'shape4'], ['h4']),
         helper.make_node('Transpose', ['h4'], ['kv'], perm=[0, 2, 1, 3])]
inputs = [helper.make_tensor_value_info('input_ids', TensorProto.INT64, ['batch', 'seq']),
          helper.make_tensor_value_info('attention_mask', TensorProto.INT64, ['batch', 'total']),
          helper.make_tensor_value_info('position_ids', TensorProto.INT64, ['batch', 'seq'])]
outputs = [helper.make_tensor_value_info('logits', TensorProto.FLOAT, ['batch', 'seq', V])]
for i in range(L):
    for kind in ('key', 'value'):
        inputs.append(helper.make_tensor_value_info(f'past_key_values.{i}.{kind}', TensorProto.FLOAT, ['batch', KV, 'past', D]))
        outputs.append(helper.make_tensor_value_info(f'present.{i}.{kind}', TensorProto.FLOAT, ['batch', KV, 'total', D]))
        nodes.append(helper.make_node('Concat', [f'past_key_values.{i}.{kind}', 'kv'], [f'present.{i}.{kind}'], axis=2))
# attention_mask・position_ids は使わない入力だが、本物と同じ名前で受け取る（Identity でグラフにつなぐ）
nodes += [helper.make_node('Identity', ['attention_mask'], ['am_unused']), helper.make_node('Identity', ['position_ids'], ['pos_unused'])]
graph = helper.make_graph(nodes, 'tiny_qwen2', inputs, outputs, initializer=[emb, W, B, shape4])
m = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='tinyswallow-chat-test')
m.ir_version = 8
onnx.checker.check_model(m)
onnx.save(m, os.path.join(out, 'onnx', 'model_q4.onnx'))
print('vocab', V, 'eos', eos, 'files', sorted(os.listdir(out)), sorted(os.listdir(os.path.join(out, 'onnx'))))
