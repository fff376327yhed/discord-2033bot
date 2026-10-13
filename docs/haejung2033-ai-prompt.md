# 해정2033 창작마당 — AI 스토리 생성 프롬프트 (복붙용)

아래 전체를 그대로 AI(챗GPT/클로드/디스코드 봇 등 무엇이든)에게 붙여넣고,
맨 아래 "주제" 줄만 원하는 내용으로 바꿔서 쓰면 됩니다.

---

너는 "해정2033 창작마당"이라는 분기형 인터랙티브 스토리 에디터용 데이터를 만드는 작가다.
아래 스키마와 규칙을 **정확히** 지켜서, 설명 없이 JSON 코드블록 하나만 출력해라.

## 출력 형식

```json
{
  "title": "...",            // 50자 이내
  "description": "...",      // 500자 이내
  "tags": ["...", "..."],    // 최대 5개, 각 20자 이내
  "startSceneId": "...",     // scenes의 키 중 하나
  "config": {
    "stats":     { "키": { "label": "이름", "initial": 숫자, "min": 숫자, "max": 숫자, "onZero": "장면키(선택)" } },
    "resources": { "키": { "label": "이름", "initial": 숫자, "min": 숫자, "max": 숫자 } },
    "factions":  { "키": { "label": "이름(=호감도)", "initial": 숫자, "min": -100, "max": 100 } },
    "items":     { "키": { "label": "이름" } },
    "flags":     { "키": { "label": "이름" } },
    "startInventory": { "아이템키": 개수 }
  },
  "scenes": {
    "장면키": {
      "body": "본문(1800자 이내)",
      "imageUrl": null,
      "station": null,
      "isEnding": false,
      "endingName": null,
      "endingType": null,
      "onEnter": [ { "type":"stat|resource|faction|item", "key":"...", "delta": 숫자 } 또는 { "type":"flag", "key":"...", "value": true|false } ],
      "choices": [
        {
          "label": "버튼 문구(80자 이내)",
          "to": "이동할 장면키",
          "condition": [ { "type":"stat|resource|faction|item", "key":"...", "op": ">=|<=|>|<|==|!=", "value": 숫자 } 또는 { "type":"flag", "key":"...", "value": true|false } ],
          "effects": [ 위와 같은 형식, delta 사용 ],
          "hideWhenLocked": true 또는 false
        }
      ]
    }
  }
}
```

## 반드시 지킬 규칙

1. 키(scenes/stats/resources/factions/items/flags의 키)는 영문/숫자/_/- 로만, 40자 이내.
2. `onZero`를 쓴 stat이 있으면, 그 값이 적힌 scene(보통 "실패/죽음 엔딩")이 scenes 안에 실제로 존재해야 함.
3. `isEnding: false`인 장면은 **choices가 최소 1개** 있어야 함 (막다른 길 금지).
4. 모든 `choice.to`는 scenes 안에 실제로 존재하는 키여야 함.
5. 선택지는 장면당 최대 5개, condition/effects는 각각 최대 10개.
6. 한 장면 안에서 똑같은 선택만 반복되지 않게, 조건(condition)으로 분기가 실제로 갈리게 만들 것.
7. **파벌(factions) = 호감도** 시스템이다. 최소 2개 세력을 넣고, 선택에 따라 올리고 내리는 선택지를 각각 섞을 것.
8. 엔딩은 최소 3개 이상(굿/배드/히든 섞어서) 만들고, 그중 최소 1개는 "stat이 0이 되는" onZero 엔딩, 최소 1개는 "특정 호감도 이상이어야만 열리는" 히든/굿 엔딩으로 만들 것.
9. 설명 문장이나 주석 없이, 위 JSON 하나만 출력할 것 (마크다운 코드블록은 써도 됨).

## 주제

(여기에 원하는 설정을 적으세요. 예: "2033년 가스에 잠긴 지하철역 생존물, 수비대와 암시장 세력 간 호감도", "학원 로맨스, 3명의 공략 캐릭터", "던전 탐험 판타지, 체력/마나 스탯" 등)
