import {hostedLayers, REMOTION_HOSTED_LAYER_ARN} from '../shared/hosted-layers';

test('All hosted layers should match ARN', () => {
	Object.values(hostedLayers).forEach((h) => {
		h.forEach(({layerArn}) => {
			expect(layerArn).toMatch(
				new RegExp(REMOTION_HOSTED_LAYER_ARN.replace(/\*/g, '(.*)'))
			);
		});
	});
});
