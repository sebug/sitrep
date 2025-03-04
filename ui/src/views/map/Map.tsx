
import './control-panel.css';
import "./Map.scss";
import { AddFeatureToLayer, DeleteFeature, GetLayers, ModifyFeature } from './graphql';
import { AddFeatureVars, DeleteFeatureVars, GetLayersData, GetLayersVars, Layer, ModifyFeatureVars } from 'types/layer';
import { BabsIconController } from './controls/BabsIconController';
import { CleanFeature, FilterActiveFeatures, LayerToFeatureCollection } from './utils';
import { displayStyle, drawStyle } from './style';
import { Feature, Geometry, GeoJsonProperties, FeatureCollection } from "geojson";
import { first } from 'lodash';
import { FullscreenControl, Map, MapProvider, NavigationControl, ScaleControl, Source, useMap, Layer as MapLayer, AttributionControl } from 'react-map-gl/maplibre';
import { LayerContext, LayersProvider } from './LayerContext';
import { StyleController, selectedStyle } from './controls/StyleController';
import { memo, useCallback, useContext, useEffect, useState } from 'react';
import { useMutation, useQuery, useReactiveVar } from '@apollo/client';
import { useParams } from 'react-router-dom';
import bbox from "@turf/bbox";
import DrawControl from './controls/DrawControl';
import EnrichedLayerFeatures, { EnrichedSymbolSource } from 'components/map/EnrichedLayerFeatures';
import ExportControl from './controls/ExportControl';
import LayerControl from './controls/LayerControl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import maplibregl from 'maplibre-gl';
import classNames from 'classnames';

const modes = {
    ...MapboxDraw.modes,
};

function MapView() {

    const mapStyle = useReactiveVar(selectedStyle);
    maplibregl.setMaxParallelImageRequests(150);
    maplibregl.setWorkerCount(6);

    const mapClass = classNames({
        'maplibre': true,
        "container-flex": true,
    });

    return (
        <>
            <h3 className="title is-size-3 is-capitalized">Lage</h3>
            <div className={mapClass}>
                <Map
                    mapLib={maplibregl}
                    onLoad={(e) => console.log(e)}
                    initialViewState={{
                        latitude: 46.87148,
                        longitude: 8.62994,
                        zoom: 5,
                        bearing: 0,
                    }}
                    attributionControl={false}
                    minZoom={9}
                    maxZoom={19}
                    mapStyle={mapStyle.uri}
                    scrollZoom={true}
                    reuseMaps={false}
                >
                    <AttributionControl position='bottom-left' compact={true} />
                    {/* All Map Controls */}
                    <FullscreenControl position={'top-left'} />
                    <NavigationControl position={'top-left'} visualizePitch={true} />
                    <ScaleControl unit={"metric"} position={'bottom-left'} />
                    <ExportControl position="bottom-left" />
                    {/* Layersprovider and Draw */}
                    <Layers />
                </Map>
            </div >
        </>
    );
}

function Layers() {
    const { state } = useContext(LayerContext);

    return (
        <LayersProvider >
            <LayerFetcher />
            <div className="maplibregl-ctrl-bottom-right" >
                <LayerControl />
                <StyleController />
            </div>

            {/* Active Layer */}
            <ActiveLayer />

            {/* Inactive Layers */}
            <InactiveLayers layers={state.layers.filter(l => l.id !== state.activeLayer) || []} />
        </LayersProvider>
    )
}


// LayerFetcher polls from the layers and sets the layers from remote
function LayerFetcher() {
    const { incidentId } = useParams();
    const { state, dispatch } = useContext(LayerContext);

    const { data, loading } = useQuery<GetLayersData, GetLayersVars>(GetLayers, {
        variables: { incidentId: incidentId || "" },
        pollInterval: 3000,
        fetchPolicy: "cache-and-network",
    });

    useEffect(() => {
        if (!loading && data && data.layers !== state.layers) {
            dispatch({ type: "SET_LAYERS", payload: { layers: data.layers } });
        }
    }, [data, dispatch, loading, state.activeLayer, state.layers])

    return (<></>)
}

function ActiveLayer() {
    const [initialized, setInitalized] = useState(false);
    const { current: map } = useMap();
    const { state } = useContext(LayerContext);
    const featureCollection = LayerToFeatureCollection(first(state.layers.filter(l => l.id === state.activeLayer)));

    useEffect(() => {
        let fc = FilterActiveFeatures(featureCollection);
        if (initialized || !map?.loaded) {
            return
        }
        // only run this for the initialization as we don't want to continously 
        // change the map viewport on new features
        if (map !== undefined && fc.features.length > 0) {
            let bboxArray = bbox(fc);
            map.fitBounds(
                [[bboxArray[0], bboxArray[1]], [bboxArray[2], bboxArray[3]]],
                {
                    animate: true,
                    padding: { top: 30, bottom: 30, left: 30, right: 30, }
                }
            );
            setInitalized(true);
        }
    }, [featureCollection, map, initialized, setInitalized]);

    return (
        <>
            <MemoDraw activeLayer={state.activeLayer} />
            <EnrichedLayerFeatures id={state.activeLayer} featureCollection={featureCollection} selectedFeature={state.selectedFeature} />
            <BabsIconController />
        </>
    )
}

const MemoDraw = memo(Draw)
function Draw(props: { activeLayer: string | undefined }) {
    const { state, dispatch } = useContext(LayerContext);
    const { incidentId } = useParams();
    const { current: map } = useMap();

    const [addFeature] = useMutation<Feature, AddFeatureVars>(AddFeatureToLayer, {
        refetchQueries: [{ query: GetLayers, variables: { incidentId: incidentId } }]
    });
    const [modifyFeature] = useMutation<Feature, ModifyFeatureVars>(ModifyFeature, {
        refetchQueries: [{ query: GetLayers, variables: { incidentId: incidentId } }]
    });

    const [deleteFeature] = useMutation<Feature, DeleteFeatureVars>(DeleteFeature, {
        refetchQueries: [{ query: GetLayers, variables: { incidentId: incidentId } }]
    });

    const onSelectionChange = useCallback((e: any) => {
        const features: Feature[] = e.features;
        if (features?.length > 0) {
            const feature = first(features);
            dispatch({ type: "SELECT_FEATURE", payload: { id: feature?.id } })
        }
        else {
            dispatch({ type: "DESELECT_FEATURE", payload: {} });
        }
    }, [dispatch]);

    const onCreate = useCallback((e: FeatureEvent) => {
        if (props.activeLayer === undefined) {
            return
        }

        const createdFeatures: Feature[] = e.features;
        createdFeatures.forEach(f => {
            let feature = CleanFeature(f)
            dispatch({
                type: "ADD_FEATURE", payload: {
                    layerId: props.activeLayer,
                    feature: {
                        geometry: feature.geometry,
                        id: feature.id,
                        properties: feature.properties,
                        createdAt: f.properties?.createdAt,
                        updatedAt: f.properties?.updatedAt,
                        deletedAt: f.properties?.deletedAt,
                    }
                }
            })
            dispatch({ type: "SELECT_FEATURE", payload: { id: feature.id } })
            addFeature({ variables: { layerId: props.activeLayer || "", geometry: feature.geometry, id: feature.id, properties: feature.properties } })
        })
    }, [props.activeLayer, dispatch, addFeature]);

    const onUpdate = useCallback((e: FeatureEvent) => {
        const updatedFeatures: Feature[] = e.features;
        updatedFeatures.forEach(f => {
            let feature = CleanFeature(f);
            dispatch({
                type: "MODIFY_FEATURE", payload: {
                    layerId: props.activeLayer,
                    feature: {
                        geometry: feature.geometry,
                        id: feature.id,
                        properties: feature.properties,
                        createdAt: f.properties?.createdAt,
                        updatedAt: f.properties?.updatedAt,
                        deletedAt: f.properties?.deletedAt,
                    }
                }
            });
            modifyFeature({ variables: { id: feature.id, geometry: feature.geometry, properties: feature.properties } });
        });
        dispatch({ type: "DESELECT_FEATURE", payload: {} });
    }, [dispatch, props.activeLayer, modifyFeature]);

    const onDelete = useCallback((e: FeatureEvent) => {
        const deletedFeatures: Feature[] = e.features;
        deletedFeatures.forEach(f => {
            let feature = CleanFeature(f);
            deleteFeature({ variables: { id: feature.id, deletedAt: new Date() } })
            dispatch({ type: "DELETE_FEATURE", payload: { featureId: f.id?.toString(), layerId: props.activeLayer } });
        });
        dispatch({ type: "DESELECT_FEATURE", payload: {} });
    }, [dispatch, props.activeLayer, deleteFeature]);

    const onCombine = useCallback((e: CombineFeatureEvent) => {
        onCreate({ features: e.createdFeatures })
        onDelete({ features: e.deletedFeatures })
        dispatch({ type: "DESELECT_FEATURE", payload: {} });
    }, [dispatch, onCreate, onDelete]);


    // this is the effect which syncs the drawings
    useEffect(() => {
        if (state.draw && map?.loaded) {
            const featureCollection: FeatureCollection = FilterActiveFeatures(LayerToFeatureCollection(state.layers.find(l => l.id === props.activeLayer)))
            state.draw.deleteAll()
            state.draw.set(featureCollection)
        }
    }, [state.draw, map?.loaded, state.layers, props.activeLayer])

    // this is the effect which syncs the drawings
    useEffect(() => {
        if (state.draw && map?.loaded) {
            if (state.selectedFeature === undefined) {
                state.draw?.changeMode("simple_select")
            }
        }
    }, [state.draw, map?.loaded, state.selectedFeature])


    if (props.activeLayer === undefined) {
        return (<></>)
    }

    return (
        <>
            <DrawControl
                onSelectionChange={onSelectionChange}
                onCreate={onCreate}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onCombine={onCombine}
                position="top-right"
                displayControlsDefault={true}
                styles={drawStyle}
                controls={{
                    polygon: true,
                    trash: true,
                    point: true,
                    line_string: true,
                    combine_features: false,
                    uncombine_features: false,
                }}
                boxSelect={false}
                clickBuffer={10}
                defaultMode="simple_select"
                modes={modes}
                userProperties={true}
            />
        </>
    )

}

function InactiveLayers(props: { layers: Layer[] }) {
    const { layers } = props;

    return (
        <>
            {
                layers.map(l =>
                    <InactiveLayer key={l.id} id={l.id} featureCollection={FilterActiveFeatures(LayerToFeatureCollection(l))} />
                )
            }
        </>
    )
}
function InactiveLayer(props: { featureCollection: FeatureCollection, id: string }) {
    const { featureCollection, id } = props;

    return (
        <>
            <EnrichedSymbolSource id={id} featureCollection={featureCollection} />
            <Source key={id} id={id} type="geojson" data={featureCollection}>
                {
                    displayStyle.map(s => <MapLayer key={s.id} id={s.id + id} {...s} />)
                }
            </Source>
        </>
    )
}



function MapWithProvder() {
    return (
        <MapProvider>
            <MapView />
        </MapProvider>
    )
}

export { MapWithProvder as Map };

export type FeatureEvent = {
    features: Feature<Geometry, GeoJsonProperties>[]
}

export type CombineFeatureEvent = {
    deletedFeatures: Feature<Geometry, GeoJsonProperties>[]
    createdFeatures: Feature<Geometry, GeoJsonProperties>[]
}