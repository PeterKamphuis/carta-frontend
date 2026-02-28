import * as React from "react";
import * as AST from "ast_wrapper";
import {CARTA} from "carta-protobuf";
import classNames from "classnames";
import * as _ from "lodash";
import {observer} from "mobx-react";

import {ImageItem, ImageType, SPECTRAL_TYPE_STRING} from "models";
import {AppStore, OverlaySettings, OverlayStore, PreferenceStore} from "stores";

import "./OverlayComponent.scss";

export class OverlayComponentProps {
    overlaySettings: OverlaySettings;
    overlayStore: OverlayStore;
    image: ImageItem;
    docked: boolean;
    top?: number;
    left?: number;
    unscaled?: boolean;
    channelMapDrawFunction?: (canvas: HTMLCanvasElement) => void;
}

@observer
export class OverlayComponent extends React.Component<OverlayComponentProps> {
    canvas: HTMLCanvasElement;

    componentDidMount() {
        this.updateImage();
    }

    componentDidUpdate() {
        this.updateImage();
    }

    updateImage() {
        AppStore.Instance.resetImageRatio();
        if (PreferenceStore.Instance.limitOverlayRedraw) {
            this.throttledRenderCanvas();
        } else {
            requestAnimationFrame(this.renderCanvas);
        }
    }

    updateImageDimensions() {
        if (this.canvas) {
            this.canvas.width = this.props.overlayStore.viewWidth * devicePixelRatio * AppStore.Instance.imageRatio;
            this.canvas.height = this.props.overlayStore.viewHeight * devicePixelRatio * AppStore.Instance.imageRatio;
        }
    }

    renderCanvas = () => {
        const settings = this.props.overlaySettings;
        const frame = this.props.image?.type === ImageType.COLOR_BLENDING ? this.props.image.store?.baseFrame : this.props.image?.store;
        const appStore = AppStore.Instance;
        const padding = this.props.overlayStore.padding;

        const wcsInfoSelected = frame.isOffsetCoord ? frame.wcsInfoShifted : frame.wcsInfo;
        const wcsInfo = frame.spatialReference ? frame.transformedWcsInfo : wcsInfoSelected;
        const frameView = this.props.unscaled
            ? {
                  xMin: padding.left * appStore.pixelRatio,
                  xMax: this.props.overlayStore.viewWidth * appStore.pixelRatio - padding.right * appStore.pixelRatio,
                  yMin: (frame.aspectRatio ?? 1) * padding.bottom * appStore.pixelRatio,
                  yMax: (frame.aspectRatio ?? 1) * this.props.overlayStore.viewHeight * appStore.pixelRatio - padding.top * appStore.pixelRatio,
                  mip: 1
              }
            : frame.spatialReference
              ? frame.spatialReference.requiredFrameView
              : frame.requiredFrameView;
        if (wcsInfo && frameView && this.canvas) {
        const tempWcsInfo = AST.copy(wcsInfo);
        if (!tempWcsInfo) {
            console.log("Create wcs info copy failed.");
            return;
        }            this.updateImageDimensions();
            AST.setCanvas(this.canvas);
            if (!frame.hasSquarePixels) {
                const scaleMapping = AST.scaleMap2D(1.0, 1.0 / frame.aspectRatio);
                const newFrame = AST.frame(2, "Domain=PIXEL");
                AST.addFrame(tempWcsInfo, 1, scaleMapping, newFrame);
                AST.setI(tempWcsInfo, "Base", frame.isOffsetCoord ? 4 : 3);
                AST.setI(tempWcsInfo, "Current", OverlaySettings.Instance.isImgCoordinates ? 3 : 2);
            }

            if (frame.isOffsetCoord && OverlaySettings.Instance.isWcsCoordinates) {
                const fovSizeInArcsec = frame.getWcsSizeInArcsec(frame.fovSize);
                const viewSize = fovSizeInArcsec.x > fovSizeInArcsec.y ? fovSizeInArcsec.y : fovSizeInArcsec.x;
                const factor = 2; // jump factor
                let unit;
                let format;

                if (viewSize < 60 * factor) {
                    unit = "arcsec";
                    format = "s.*";
                } else if (viewSize < 3600 * factor) {
                    unit = "arcmin";
                    format = "m.*";
                } else {
                    unit = "deg";
                    format = "d.*";
                }

                // disable unit labels when custom labels on
                if (settings.labels.customText) {
                    AST.set(tempWcsInfo, `Format(1)=${format}, Format(2)=${format}, Unit(1)="", Unit(2)=""`);
                } else {
                    AST.set(tempWcsInfo, `Format(1)=${format}, Format(2)=${format}, Unit(1)=${unit}, Unit(2)=${unit}`);
                }
            }

            if (settings.labels.customText) {
                // Disable the PV image labels when custom labels are set
                AST.set(tempWcsInfo, `Unit(1)="", Unit(2)=""`);
            }

            const plot = (styleString: string) => {
                AST.plot(
                    tempWcsInfo,
                    frameView.xMin,
                    frameView.xMax,
                    frameView.yMin / frame.aspectRatio,
                    frameView.yMax / frame.aspectRatio,
                    this.props.overlayStore.viewWidth * appStore.pixelRatio,
                    this.props.overlayStore.viewHeight * appStore.pixelRatio,
                    padding.left * appStore.pixelRatio,
                    padding.right * appStore.pixelRatio,
                    padding.top * appStore.pixelRatio,
                    padding.bottom * appStore.pixelRatio,
                    styleString
                );
            };

            let currentStyleString = this.props.overlayStore.styleString(frame);

            // Override the AST tolerance during motion
            if (frame.moving) {
                const tolVal = Math.max((settings.global.tolerance * 2) / 100.0, 0.1);
                currentStyleString += `, Tol=${tolVal}`;
            }

            if (!frame.validWcs) {
                //Remove system and format entries
                currentStyleString = currentStyleString.replace(/System=.*?,/, "").replaceAll(/Format\(\d\)=.*?,/g, "");
            }

            if (!settings.title.customText) {
                currentStyleString += `, Title="${this.props.image?.store?.filename.replace(/%/g, "%%%%").replace(/"/g, "”")}"`;
            } else if (this.props.image?.store?.titleCustomText?.length) {
                currentStyleString += `, Title="${this.props.image?.store?.titleCustomText.replace(/%/g, "%%%%").replace(/"/g, "”")}"`;
            } else {
                currentStyleString += `, Title=${""}`;
            }

            if (frame.isOffsetCoord) {
                currentStyleString += `, LabelUnits=1`;
            }

            plot(currentStyleString);

            if (/No grid curves can be drawn for axis/.test(AST.getLastErrorMessage())) {
                // Try to re-plot without the grid
                plot(currentStyleString.replace(/Gap\(\d\)=[^,]+, ?/g, "").replace("Grid=1", "Grid=0"));
            }

            AST.deleteObject(tempWcsInfo);
            AST.clearLastErrorMessage();

            if (this.props.channelMapDrawFunction) {
                this.props.channelMapDrawFunction(this.canvas);
            }
        }
    };

    throttledRenderCanvas = _.throttle(this.renderCanvas, 50);

    private getRef = ref => {
        this.canvas = ref;
    };

    render() {
        const frame = this.props.image?.type === ImageType.COLOR_BLENDING ? this.props.image.store?.baseFrame : this.props.image?.store;
        const refFrame = frame.spatialReference ?? frame;
        // changing the frame view, padding or width/height triggers a re-render

        const w = this.props.overlayStore.viewWidth;
        const h = this.props.overlayStore.viewHeight;
        // Dummy variables for triggering re-render
        /* eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars */
        const styleString = this.props.overlayStore.styleString;
        const frameView = refFrame.requiredFrameView;
        const framePadding = this.props.overlayStore.padding;
        const moving = frame.moving;
        const system = this.props.overlaySettings.global.system;
        const globalColor = this.props.overlaySettings.global.color;
        const titleColor = this.props.overlaySettings.title.color;
        const gridColor = this.props.overlaySettings.grid.color;
        const borderColor = this.props.overlaySettings.border.color;
        const oticksColor = this.props.overlaySettings.ticks.color;
        const axesColor = this.props.overlaySettings.axes.color;
        const numbersColor = this.props.overlaySettings.numbers.color;
        const labelsColor = this.props.overlaySettings.labels.color;
        const darktheme = AppStore.Instance.darkTheme;
        const title = this.props.overlaySettings.title.customText ? this.props.image?.store?.titleCustomText : this.props.image?.store?.filename;
        const ratio = AppStore.Instance.imageRatio;
        const raDecReference = this.props.overlaySettings.labels.raDecReference;
        const titleStyleString = this.props.overlaySettings.title.styleString;
        const gridStyleString = this.props.overlaySettings.grid.styleString;
        const borderStyleString = this.props.overlaySettings.border.styleString;
        const ticksStyleString = this.props.overlaySettings.ticks.styleString;
        const axesStyleString = this.props.overlaySettings.axes.styleString;
        const numbersStyleString = this.props.overlaySettings.numbers.styleString;
        const labelsStyleString = this.props.overlaySettings.labels.styleString;
        const channelMapStartChannel = AppStore.Instance.channelMapStore.startChannel;
        const channelMapNumColumns = AppStore.Instance.channelMapStore.numColumns;
        const channelMapNumRows = AppStore.Instance.channelMapStore.numRows;
        const channelMapChannelNum = AppStore.Instance.channelMapStore.numChannels;
        const offsetCoord = frame.isOffsetCoord;
        const offsetWcs = frame.wcsInfoShifted;

        if (frame.isSwappedZ) {
            const requiredChannel = frame.requiredChannel;
        }
        /* eslint-enable no-unused-vars, @typescript-eslint/no-unused-vars */
        // Select WCS based on cube view mode - handled at FrameStore level now
        const wcsInfo = frame.wcsInfo;
        
        // Trigger switching AST overlay axis for PV image
        // For cube view modes, spectral axis is axis 2 in the 2D swapped frame
        const isCubeViewMode = frame.cubeViewMode !== CARTA.CubeViewMode.VIEW_MODE_XY;
        const spectralAxisNumber = isCubeViewMode ? 2 : frame.spectral;
        
        const spectralAxisSetting =
            `${frame.spectralType ? `System(${spectralAxisNumber})=${frame.spectralType},` : ""}` +
            `${frame.spectralUnit ? `Unit(${spectralAxisNumber})=${frame.spectralUnit},` : ""}` +
            `${frame.spectralSystem ? `StdOfRest=${frame.spectralSystem},` : ""}` +
            `${frame.restFreqStore.restFreqInHz ? `RestFreq=${frame.restFreqStore.restFreqInHz} Hz,` : ""}` +
            `${frame.spectralType && frame.spectralSystem ? `Label(${spectralAxisNumber})=[${frame.spectralSystem}] ${SPECTRAL_TYPE_STRING.get(frame.spectralType)},` : ""}`;
        
        // For cube view modes, leave formatting to default since LINEAR coordinates don't support HMS/DMS
        let cubeViewFormatSetting = "";
        // Use cube view mode aware axis labels and coordinates
        let dirAxesSetting = "";
        if (isCubeViewMode) {
            // In cube view mode, axis 1 is spatial, axis 2 is spectral (already handled above)
            // For the spatial axis (axis 1 in 2D frame), always use dirXLabel which contains the correct spatial coordinate
            const spatialAxisLabel = frame.dirXLabel;
            if (spatialAxisLabel !== "") {
                dirAxesSetting = `Label(1)=${spatialAxisLabel},`;
            }
        } else {
            // Normal XY mode
            dirAxesSetting = `${frame.overlayDirX > 3 || frame.dirXLabel === "" ? "" : `Label(${frame.overlayDirX})=${frame.dirXLabel},`} ${frame.overlayDirY > 3 || frame.dirYLabel === "" ? "" : `Label(${frame.overlayDirY})=${frame.dirYLabel},`}`;
        }
        
            if (frame.isPVImage && frame.spectralAxis?.valid) {
                AST.set(wcsInfo, spectralAxisSetting);
            } else if ((frame.isSwappedZ || frame.cubeViewMode !== CARTA.CubeViewMode.VIEW_MODE_XY) && frame.spectralAxis?.valid) {
                // SwappedZ and cube view modes (YZ/XZ) - use spectral axis settings with direction labels
                AST.set(wcsInfo, cubeViewFormatSetting + spectralAxisSetting + dirAxesSetting);
            } else {
                const formatStringX = this.props.overlaySettings.numbers.formatStringX;
                const formatStyingY = this.props.overlaySettings.numbers.formatStringY;
                const explicitSystem = this.props.overlaySettings.global.explicitSystem;
                if (formatStringX !== undefined && formatStyingY !== undefined && explicitSystem !== undefined && OverlaySettings.Instance.isWcsCoordinates && frame.validWcs) {
                    // Use standard overlay settings - cube view WCS is handled at FrameStore level
                    AST.set(wcsInfo, `Format(${frame.overlayDirX})=${formatStringX}, Format(${frame.overlayDirY})=${formatStyingY}, System=${explicitSystem},` + dirAxesSetting);
                }
            }

        const className = classNames("overlay-canvas", {docked: this.props.docked});

        return <canvas className={className} style={{top: this.props.top || 0, left: this.props.left || 0, width: w, height: h}} id="overlay-canvas" ref={this.getRef} key={`overlay-canvas-${frame.frameInfo.fileId}`} />;
    }
}
