#!/usr/bin/env python3
"""
spaCy sidecar HTTP server
为 TypeScript s0 阶段提供更精确的名词抽取
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import spacy
import sys
import os

app = Flask(__name__)
CORS(app)

# 全局加载 spaCy 模型
nlp = None
MODEL_NAME = os.getenv('SPACY_MODEL', 'fr_core_news_sm')

def load_model():
    global nlp
    try:
        print(f"Loading spaCy model: {MODEL_NAME}...", file=sys.stderr)
        nlp = spacy.load(MODEL_NAME)
        print(f"Model loaded successfully.", file=sys.stderr)
    except OSError:
        print(f"Model {MODEL_NAME} not found. Downloading...", file=sys.stderr)
        from spacy.cli import download
        download(MODEL_NAME)
        nlp = spacy.load(MODEL_NAME)
        print(f"Model downloaded and loaded.", file=sys.stderr)

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'ok',
        'model': MODEL_NAME,
        'loaded': nlp is not None
    })

@app.route('/extract_nouns', methods=['POST'])
def extract_nouns():
    """
    从文本中抽取名词和专有名词
    
    请求体:
    {
        "text": "待处理文本",
        "include_proper_nouns": true,  # 是否包含专有名词 (PROPN)
        "include_nouns": true,          # 是否包含普通名词 (NOUN)
        "min_length": 2                 # 最小长度（字符）
    }
    
    返回:
    {
        "nouns": [
            {
                "surface": "Machine learning",
                "start": 0,
                "end": 16,
                "pos": "NOUN",
                "tag": "NN"
            },
            ...
        ]
    }
    """
    if not nlp:
        return jsonify({'error': 'Model not loaded'}), 500
    
    data = request.json
    if not data or 'text' not in data:
        return jsonify({'error': 'Missing "text" field'}), 400
    
    text = data['text']
    include_proper = data.get('include_proper_nouns', True)
    include_nouns = data.get('include_nouns', True)
    min_length = data.get('min_length', 2)
    
    # 使用 spaCy 处理文本
    doc = nlp(text)
    
    nouns = []
    for token in doc:
        # 检查是否为名词或专有名词
        if (token.pos_ == 'PROPN' and include_proper) or \
           (token.pos_ == 'NOUN' and include_nouns):
            surface = token.text
            if len(surface) >= min_length:
                nouns.append({
                    'surface': surface,
                    'start': token.idx,
                    'end': token.idx + len(surface),
                    'pos': token.pos_,
                    'tag': token.tag_
                })
    
    # 处理名词短语（NP chunks）
    noun_phrases = []
    for chunk in doc.noun_chunks:
        # 只取有意义的名词短语（至少包含一个名词或专有名词）
        has_noun = any(t.pos_ in ['NOUN', 'PROPN'] for t in chunk)
        if has_noun and len(chunk.text) >= min_length:
            noun_phrases.append({
                'surface': chunk.text,
                'start': chunk.start_char,
                'end': chunk.end_char,
                'pos': 'NP',
                'tag': 'NP'
            })
    
    return jsonify({
        'nouns': nouns,
        'noun_phrases': noun_phrases,
        'total': len(nouns) + len(noun_phrases)
    })

@app.route('/extract_nouns_batch', methods=['POST'])
def extract_nouns_batch():
    """
    批量抽取名词
    
    请求体:
    {
        "texts": ["text1", "text2", ...],
        "include_proper_nouns": true,
        "include_nouns": true,
        "min_length": 2
    }
    
    返回:
    {
        "results": [
            { "nouns": [...], "noun_phrases": [...] },
            ...
        ]
    }
    """
    if not nlp:
        return jsonify({'error': 'Model not loaded'}), 500
    
    data = request.json
    if not data or 'texts' not in data:
        return jsonify({'error': 'Missing "texts" field'}), 400
    
    texts = data['texts']
    include_proper = data.get('include_proper_nouns', True)
    include_nouns = data.get('include_nouns', True)
    min_length = data.get('min_length', 2)
    
    results = []
    for text in texts:
        doc = nlp(text)
        
        nouns = []
        for token in doc:
            if (token.pos_ == 'PROPN' and include_proper) or \
               (token.pos_ == 'NOUN' and include_nouns):
                surface = token.text
                if len(surface) >= min_length:
                    nouns.append({
                        'surface': surface,
                        'start': token.idx,
                        'end': token.idx + len(surface),
                        'pos': token.pos_,
                        'tag': token.tag_
                    })
        
        noun_phrases = []
        for chunk in doc.noun_chunks:
            has_noun = any(t.pos_ in ['NOUN', 'PROPN'] for t in chunk)
            if has_noun and len(chunk.text) >= min_length:
                noun_phrases.append({
                    'surface': chunk.text,
                    'start': chunk.start_char,
                    'end': chunk.end_char,
                    'pos': 'NP',
                    'tag': 'NP'
                })
        
        results.append({
            'nouns': nouns,
            'noun_phrases': noun_phrases,
            'total': len(nouns) + len(noun_phrases)
        })
    
    return jsonify({'results': results})

if __name__ == '__main__':
    load_model()
    port = int(os.getenv('PORT', 5001))
    print(f"Starting spaCy sidecar on http://localhost:{port}", file=sys.stderr)
    app.run(host='0.0.0.0', port=port, debug=False)
