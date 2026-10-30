// Fixed synthetic corpus and questions, shared by the SDK and embedding-only control.
export const decisionText='The project database is SQLite. 项目数据库选择 SQLite。';
export const distractorTexts=['The project color is terracotta. 项目主题色是陶土色。','The project language is TypeScript. 项目开发语言是 TypeScript。','The release meeting is Friday. 发布讨论安排在星期五。'];
export const retrievalQueries=[
  ['持久化数据采用什么方案？','decision'],
  ['Which technology keeps our records on disk?','decision'],
  ['界面视觉要用什么色调？','distractor-0'],
  ['What hue should the interface use?','distractor-0'],
  ['代码用哪门语言编写？','distractor-1'],
  ['Which programming language should contributors use?','distractor-1'],
  ['哪天开发布会议？','distractor-2'],
  ['On which day will we discuss the release?','distractor-2'],
];
