# usage-statusline

[English](README.md) | 한국어

프롬프트 아래 상태 줄에 사용량을 표시하는 Claude Code mod입니다. 각 rate-limit 창(사용률, 초기화까지 남은 시간을 `h:mm` 또는 `Nd h:mm`로, 창 길이)에 이어 비용과 토큰을 각각 이 세션 / 오늘 순으로 보여 줍니다:

```
4% 3:14(5h) · 10% 4d 8:13(7d) · $5.72 / $18.40 · 1.23M tok / 5.20M tok
```

모델 응답이 올 때마다(턴 도중 포함) 갱신되며, 1분마다 카운트다운을 다시 그리고 오늘 합계를 다시 읽습니다. rate limit은 계정 단위이므로 어느 세션이든 가장 최근에 읽은 값을 공유합니다. 새 세션이나 유휴 세션에도 표시되고, 다른 세션이 작업하면 1분 안에 값이 바뀝니다(구독 계정만 해당하며, 어느 세션이든 응답을 한 번 받기 전에는 표시되지 않습니다). 비용과 토큰은 항상 표시되며, 아직 아무것도 사용하지 않은 세션에서는 `$0.00`, `0 tok`으로 나옵니다. mod 자체는 토큰을 쓰지 않습니다. 엔진이 이미 측정한 값을 읽어 화면에 그리기만 합니다.

**토큰**은 각 모델 응답의 usage(메인 스레드와 subagent 모두)를 합산하며, 입력·출력·캐시 읽기·캐시 쓰기 네 가지를 모두 더합니다. 캐시 읽기는 요청마다 대화를 다시 세기 때문에 합계가 컨텍스트 창보다 훨씬 빠르게 늘어납니다. 이 세션에서 mod가 로드된 시점부터 세며, 재개(resume)한 세션은 0부터 다시 셉니다. **비용**은 이 세션에 대한 엔진의 API 가격 기준 추정치이며, 구독 요금제에서는 실제 청구액이 아닙니다.

**오늘 합계**(비용과 토큰)는 로컬 자정 이후 이 기기에서 이 mod로 실행된 세션들을 합산하며, 각 세션은 mod 저장소에 자체 키로 보관됩니다. 다른 기기나 웹의 세션, mod 설치 이전의 세션은 포함되지 않습니다. 한 세션의 전체 비용은 마지막으로 측정된 날에 계산됩니다.

## 설치

Claude Code 터미널 세션의 프롬프트에서:

```
/plugin install usage-statusline --marketplace leekd123/claude-usage-statusline
```

marketplace 추가를 물으면 `y`로 답한 뒤 scope를 고릅니다(user가 첫 번째). 셸에서 설치하려면:

```bash
claude plugin install usage-statusline --marketplace leekd123/claude-usage-statusline
```

`/plugin`이 동작하지 않는 데스크톱 앱에서는: 프롬프트 입력란 옆 + 를 누르고 Plugins → Add marketplace에 `leekd123/claude-usage-statusline`을 입력한 뒤 Add plugin을 누릅니다.

이미 실행 중인 세션은 `/reload-plugins`로 적용되고, 새 세션은 자동으로 로드합니다.

## 개발

로컬 클론에서 설치하면 수정 사항이 재설치 없이 `/reload-plugins`만으로 세션에 반영됩니다:

```bash
claude plugin marketplace add <클론 경로>
```

```bash
claude plugin install usage-statusline@usage-statusline --scope user
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
