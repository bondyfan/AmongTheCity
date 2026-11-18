import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { Scene, Group } = await import('three');
const { installSceneGraphPolicy, freezeStatic } = await import('../js/scenegraph.js');

test('a hidden static branch catches up when shown or moved to a different parent', () => {
  const scene = new Scene(), block = new Group(), shop = new Group(), sign = new Group();
  installSceneGraphPolicy(scene);
  block.position.x = 25;
  sign.position.x = 3;
  shop.add(sign);
  shop.visible = false;
  block.add(shop);
  scene.add(freezeStatic(block));
  scene.updateMatrixWorld();
  shop.visible = true;
  scene.updateMatrixWorld();
  assert.equal(sign.matrixWorld.elements[12], 28);
  scene.add(shop);
  scene.updateMatrixWorld();
  assert.equal(sign.matrixWorld.elements[12], 3);
});

test('a hidden manual world matrix receives the forced update from a frozen parent', () => {
  const scene = new Scene(), block = new Group(), child = new Group();
  installSceneGraphPolicy(scene);
  child.visible = false;
  child.matrixWorldAutoUpdate = false;
  block.position.x = 8;
  block.add(child);
  scene.add(freezeStatic(block));
  scene.updateMatrixWorld();
  child.visible = true;
  scene.updateMatrixWorld();
  assert.equal(child.matrixWorld.elements[12], 8);
});
