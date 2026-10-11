// 엔진 외부 공개 창구: 다른 코드는 여기서만 import 한다.
export { createInitialState } from './state.js';
export { checkCondition, checkConditions, describeCondition } from './conditions.js';
export { applyEffects } from './effects.js';
export { startStory, advance, enterScene, getAvailableChoices } from './engine.js';
export { validateStory } from './validate.js';