import fs, {closeSync, readFileSync, readSync} from 'fs';
import * as PImage from 'pureimage';
import {Line} from 'pureimage/dist/line';

const DATA_START = 44;

type Options = {
	width: number;
	height: number;
	rms: boolean;
	maximums: boolean;
	average: boolean;
	start: 'START';
	end: 'END';
	colors: {
		maximums: string;
		rms: string;
		background: string;
	};
	filename: string;
};

type Sample = {
	posRms?: number;
	negRms?: number;
	posMax?: number;
	negMax?: number;
};

const getStringBE = (bytes: Buffer) => {
	const arr = Array.prototype.slice.call(bytes, 0);
	let result = '';
	for (let i = 0; i < arr.length; i += 1) {
		result += String.fromCharCode(arr[i]);
	}

	return result;
};

type Chunk =
	| {
			type: 'fmt';
			chunkSize: number;
			audioFormat: number;
			numChannels: number;
			sampleRate: number;
			byteRate: number;
			blockAlign: number;
			bitsPerSample: number;
	  }
	| {
			type: 'data';
			chunkSize: number;
	  }
	| {
			type: 'list';
			chunkSize: number;
			listTypeId: number;
	  };

const readChunk = (
	buf: Buffer,
	currentOffset: number,
): {chunk: Chunk; offset: number} => {
	const subChunk = getStringBE(buf.slice(currentOffset, currentOffset + 4));
	if (subChunk === 'fmt ') {
		const chunkSize = buf.readInt32LE(currentOffset + 4);
		const audioFormat = buf.readUInt16LE(currentOffset + 8);
		const numChannels = buf.readUInt16LE(currentOffset + 10);
		const sampleRate = buf.readInt32LE(currentOffset + 12);
		const byteRate = buf.readInt32LE(currentOffset + 16);
		const blockAlign = buf.readUInt16LE(currentOffset + 20);
		const bitsPerSample = buf.readUInt16LE(currentOffset + 22);
		return {
			chunk: {
				audioFormat,
				bitsPerSample,
				blockAlign,
				byteRate,
				numChannels,
				sampleRate,
				chunkSize,
				type: 'fmt',
			},
			offset: currentOffset + 8 + chunkSize,
		};
	}

	if (subChunk === 'data') {
		const chunkSize = buf.readInt32LE(currentOffset + 4);
		return {
			chunk: {
				chunkSize,
				type: 'data',
			},
			offset: currentOffset + 8 + chunkSize,
		};
	}

	if (subChunk === 'LIST') {
		const chunkSize = buf.readInt32LE(currentOffset + 4);
		const listTypeId = buf.readInt32LE(currentOffset + 8);
		return {
			chunk: {
				chunkSize,
				type: 'list',
				listTypeId,
			},
			offset: currentOffset + 8 + chunkSize,
		};
	}

	throw new Error('Invalid chunk type');
};

export class Wavedraw {
	path: string;
	chunks: Chunk[];

	constructor(path: string) {
		if (!path) {
			throw new Error('path to wave file must be included in constructor');
		}

		this.path = path;
		this.chunks = this.getHeader();
	}

	getHeader() {
		const buf = readFileSync(this.path);

		let currentOffset = 12;
		const chunks: Chunk[] = [];
		while (currentOffset < buf.length) {
			const {chunk, offset} = readChunk(buf, currentOffset);
			currentOffset = offset;
			chunks.push(chunk);
		}

		return chunks;
	}

	getChunk(type: Chunk['type']) {
		const found = this.chunks.find((chunk) => chunk.type === type);
		if (!found) {
			throw new Error(`Chunk type ${type} not found`);
		}

		return found;
	}

	getFileLength() {
		const chunk = this.getChunk('fmt');
		if (chunk.type !== 'fmt') {
			throw new Error('fmt chunk not found');
		}

		const numSamples = parseInt(
			(chunk.chunkSize / chunk.blockAlign) as unknown as string,
			10,
		);
		let seconds = parseInt(
			(numSamples / chunk.sampleRate) as unknown as string,
			10,
		);
		const minutes = parseInt((seconds / 60) as unknown as string, 10);
		const hours = parseInt((minutes / 60) as unknown as string, 10);
		seconds %= 60;
		return {
			seconds,
			minutes,
			hours,
		};
	}

	getOffsetInfo(
		start: undefined | 'START',
		end: undefined | 'END',
		width: number,
	) {
		let startPos;
		let endPos;

		if (start === undefined || start === 'START') {
			startPos = DATA_START;
		} else {
			startPos = this.getOffset(start) + DATA_START;
		}

		if (end === undefined || end === 'END') {
			const chunk = this.getChunk('data');
			if (chunk.type !== 'data') {
				throw new Error('data chunk not found');
			}

			endPos = chunk.chunkSize;
		} else {
			endPos = this.getOffset(end);
		}

		const fmt = this.getChunk('fmt');
		if (fmt.type !== 'fmt') {
			throw new Error('fmt chunk not found');
		}

		const blockSize = parseInt(
			(((endPos as number) - startPos) /
				(fmt.blockAlign as number) /
				width) as unknown as string,
			10,
		);
		const chunkSize = parseInt(
			(blockSize * (fmt.blockAlign as number)) as unknown as string,
			10,
		);
		return {
			startPos,
			endPos,
			blockSize,
			chunkSize,
		};
	}

	getOffset(time: string) {
		const [hours, minutes, seconds] = time
			.split(':')
			.map((unit) => parseInt(unit, 10));

		let adjustedSeconds = seconds + hours * 60 * 60;
		adjustedSeconds += minutes * 60;
		const fmt = this.getChunk('fmt');
		if (fmt.type !== 'fmt') {
			throw new Error('fmt chunk not found');
		}

		return parseInt(
			(adjustedSeconds *
				(fmt.sampleRate as number) *
				(fmt.blockAlign as number)) as unknown as string,
			10,
		);
	}

	static validateDrawWaveOptions(options: {width?: number; height?: number}) {
		if (!(options.width && options.height)) {
			throw new Error('drawWave() required parameters: width, height');
		}
	}

	async drawWave(options: Options) {
		Wavedraw.validateDrawWaveOptions(options);
		const fmt = this.getChunk('fmt');
		if (fmt.type !== 'fmt') {
			throw new Error('fmt chunk not found');
		}

		if (fmt.bitsPerSample !== 16) {
			throw new Error('drawWave() currently only supports 16 bit audio files!');
		}

		const samples = this.getSamples(options);
		const img1 = PImage.make(options.width, options.height);
		const ctx = img1.getContext('2d');
		const ceiling = 32767;

		if (options.colors && options.colors.background) {
			ctx.fillStyle = options.colors.background;
			ctx.fillRect(0, 0, options.width, options.height);
		}

		for (let i = 0; i < options.width; i += 1) {
			if (options.maximums) {
				ctx.strokeStyle =
					options.colors && options.colors.maximums
						? options.colors.maximums
						: '#0000ff';

				ctx.drawLine(
					new Line(
						i,
						Number.parseInt((options.height / 2) as unknown as string, 10),
						i,
						Number.parseInt(
							(options.height / 2 -
								(options.height / 2 / ceiling) *
									(samples[i].posMax as number)) as unknown as string,
							10,
						),
					),
				);

				ctx.drawLine(
					new Line(
						i,
						Number.parseInt((options.height / 2) as unknown as string, 10),
						i,
						Number.parseInt(
							(options.height / 2 +
								-(
									(options.height / 2 / ceiling) *
									(samples[i].negMax as number)
								)) as unknown as string,
							10,
						),
					),
				);
			}

			if (options.rms) {
				ctx.strokeStyle =
					options.colors && options.colors.rms ? options.colors.rms : '#659df7';
				ctx.drawLine(
					new Line(
						i,
						Number.parseInt((options.height / 2) as unknown as string, 10),
						i,
						Number.parseInt(
							(options.height / 2 -
								(options.height / 2 / ceiling) *
									(samples[i].posRms as number)) as unknown as string,
							10,
						),
					),
				);

				ctx.drawLine(
					new Line(
						i,
						Number.parseInt((options.height / 2) as unknown as string, 10),
						i,
						Number.parseInt(
							(options.height / 2 +
								-(
									(options.height / 2 / ceiling) *
									(samples[i].negRms as number)
								)) as unknown as string,
							10,
						),
					),
				);
			}
		}

		const {filename} = options;

		const currentFile = readFileSync(filename);
		await PImage.encodePNGToStream(img1, fs.createWriteStream(filename));
		const newFile = readFileSync(filename);
		if (Buffer.compare(currentFile, newFile) !== 0) {
			throw new Error('Waveforms are different');
		}
	}

	getSamples(options: Options) {
		if (!options.width) {
			throw new Error('getSamples() required parameter: width');
		}

		const offsetInfo = this.getOffsetInfo(
			options.start,
			options.end,
			options.width,
		);
		const file = fs.openSync(this.path, 'r');
		if (!file) {
			throw new Error(`Error opening file ${this.path}`);
		}

		const samples: Sample[] = [];
		for (let x = 0; x < options.width; x += 1) {
			const buf = new ArrayBuffer(offsetInfo.chunkSize);
			const intView = new Int16Array(buf);
			const position = offsetInfo.chunkSize * x + offsetInfo.startPos;
			readSync(file, intView, 0, offsetInfo.chunkSize, position);
			let sampleInfo = {};
			if (options.maximums) sampleInfo = {...Wavedraw.computeMaximums(intView)};
			if (options.average)
				sampleInfo = {...sampleInfo, ...Wavedraw.computeAverage(intView)};
			if (options.rms)
				sampleInfo = {...sampleInfo, ...Wavedraw.computeRms(intView)};
			samples.push(sampleInfo);
		}

		closeSync(file);
		return samples;
	}

	static computeMaximums(inputSignal: Int16Array) {
		return {
			posMax: Math.max.apply(null, inputSignal as unknown as number[]),
			negMax: Math.min.apply(null, inputSignal as unknown as number[]),
		};
	}

	static computeRms(inputSignal: Int16Array) {
		const positives = inputSignal.filter((x) => x >= 0);
		const posInt32 = Int32Array.from(positives);
		const posRms =
			posInt32.length > 0
				? Math.sqrt(
						posInt32.map((x) => x * x).reduce((a, b) => a + b, 0) /
							posInt32.length,
					)
				: 0;
		const negatives = inputSignal.filter((x) => x < 0);
		const negInt32 = Int32Array.from(negatives);
		const negRms =
			negInt32.length > 0
				? -Math.sqrt(
						Math.abs(negInt32.map((x) => x * x).reduce((a, b) => a + b, 0)) /
							negInt32.length,
					)
				: 0;
		return {
			posRms,
			negRms,
		};
	}

	static computeAverage(inputSignal: Int16Array) {
		const positives = inputSignal.filter((x) => x >= 0);
		const posAvg =
			positives.length > 0
				? positives.reduce((a, b) => a + b, 0) / positives.length
				: 0;
		const negatives = inputSignal.filter((x) => x < 0);
		const negAvg =
			negatives.length > 0
				? negatives.reduce((a, b) => a + b, 0) / negatives.length
				: 0;
		return {
			posAvg,
			negAvg,
		};
	}

	static computeDft(inputSignal: Int16Array) {
		const N = inputSignal.length;
		const pi2 = Math.PI * 2.0;
		const dftValues = [];
		for (let i = 0; i < N; i += 1) {
			dftValues[i] = {
				real: 0.0,
				imag: 0.0,
			};
			for (let j = 0; j < N; j += 1) {
				dftValues[i].real += inputSignal[j] * Math.cos((pi2 * j * i) / N);
				dftValues[i].imag += inputSignal[j] * Math.sin((pi2 * j * i) / N);
			}
		}

		return dftValues;
	}
}
