/**
 * ziku 自身を指す URL。
 *
 * 利用者のリポジトリへ書き出す文言（push が作る PR の本文）と、端末に出す案内の両方から
 * 参照される。リテラルを置き場所ごとに書くと、リポジトリを移したときに一部だけが古い場所を
 * 指したまま他人のリポジトリへ載る。
 */
export const PROJECT_URL = "https://github.com/tktcorporation/ziku";

/** 不具合の報告先。 */
export const PROJECT_ISSUES_URL = `${PROJECT_URL}/issues`;
